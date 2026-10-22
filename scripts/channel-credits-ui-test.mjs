import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

/** 实际共享组件的余额能力、查询反馈与请求交错回归。 */
export async function verifyChannelCreditsUi() {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    .replace('exports.__test = {', 'exports.__test = { ChannelCard, DICT,')
  const settle = () => new Promise(resolve => setImmediate(resolve))
  function mount(provider, rpcImpl) {
    let bundle, cursor = 0, effects = []
    const cells = [], calls = [], errors = [], events = new Map()
    const window = {
      __ModuleLoader__: { load: value => { bundle = value } },
      addEventListener: (name, callback) => events.set(name, callback),
      removeEventListener: name => events.delete(name),
    }
    const react = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      Fragment: 'fragment',
      useState(initial) {
        const index = cursor++
        if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
        return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
      },
      useRef(initial) { return cells[cursor++] ??= { current: initial } },
      useEffect(fn) { effects.push(fn) },
      useMemo: fn => fn(),
      useCallback: fn => fn,
    }
    new Function('window', source)(window)
    const { ChannelCard, DICT } = bundle.factory(() => react).__test
    const props = {
      channel: { id: provider, name: provider },
      status: { accounts: { total: 2, enabled: 2 }, models: { total: 0 } },
      t: key => DICT.zh[key],
      onChanged() {},
      onError: (_channel, error) => errors.push(error.message),
      rpc: async (method, payload) => {
        calls.push({ method, payload })
        return rpcImpl(method, payload)
      },
    }
    function render() {
      cursor = 0; effects = []
      return ChannelCard(props)
    }
    function nodes(tree) {
      const all = []
      const visit = node => {
        if (Array.isArray(node)) return node.forEach(visit)
        if (!node || typeof node !== 'object') return
        all.push(node); visit(node.children)
      }
      visit(tree)
      return all
    }
    const button = label => nodes(render()).find(node => node.type === 'button' && node.children.includes(label))
    const text = () => JSON.stringify(render())
    render()
    const load = effects[0], subscribe = effects[2]
    const cleanup = load()
    subscribe()
    return { calls, errors, cells, button, text, cleanup, events }
  }
  const claimable = new Set(['lobsterai', 'qoder', 'qodercn', 'trae', 'loomy', 'minimax', 'zcode', 'raccoon'])
  for (const provider of [...claimable, 'cline', 'raccoon', 'gemini']) {
    const app = mount(provider, async () => ({ accounts: [] }))
    await settle()
    assert.equal(app.calls[0].method, 'credits.balances', `${provider} 必须查询已有后端余额能力`)
    assert.equal(app.calls[0].payload.provider, provider)
    assert.ok(app.button('刷新余额'))
    assert.equal(Boolean(app.button('一键领取')), claimable.has(provider), `${provider} 必须单独判断签到能力`)
    if (provider === 'zcode') assert.ok(app.text().includes('剩余 Token'))
    if (provider === 'cline') assert.ok(app.text().includes('USD'))
    if (provider === 'gemini') assert.ok(app.text().includes('剩余配额'))
    app.cleanup()
  }

  let fail = false
  const accountRows = [{ id: 'one', nickname: '账号一', enabled: true }, { id: 'two', nickname: '账号二', enabled: true }]
  let balances = [
    { accountId: 'one', balance: { total: 0 } },
    { accountId: 'two', balance: null, error: '凭据已失效，请重新登录' },
  ]
  const app = mount('minimax', async method => {
    if (method === 'account.list') return { accounts: accountRows }
    if (method === 'credits.status') return { accounts: [{ accountId: 'one', status: { todayCheckedIn: true, todayCredit: 10 } }] }
    if (method === 'credits.balances') {
      if (fail) throw new Error('网络暂时断开')
      return { accounts: balances }
    }
    if (method === 'credits.claimAll') return { summary: { claimed: 0 }, results: [{ accountId: 'two', outcome: { kind: 'failed', message: '签到凭据过期' } }] }
    throw new Error(`意外的 RPC ${method}`)
  })
  await settle()
  assert.ok(app.text().includes('1 个账号未能查询余额'))
  app.button('账号').props.onClick()
  await settle()
  assert.ok(app.text().includes('凭据已失效，请重新登录'))
  assert.ok(app.text().includes('剩余积分 0'), '零余额必须显示，不能变成查询失败')
  assert.ok(app.text().includes('今日已领 10'), '签到状态只解包一次')
  fail = true
  app.button('刷新余额').props.onClick()
  await settle()
  assert.equal(app.calls.filter(row => row.method === 'credits.balances').at(-1).payload.force, true, '手动重试必须跳过配额缓存')
  assert.ok(app.text().includes('余额查询失败：网络暂时断开'))
  assert.equal(app.button('刷新余额').props.disabled, false)
  fail = false
  balances = accountRows.map(row => ({ accountId: row.id, balance: { total: 123 } }))
  app.button('刷新余额').props.onClick()
  await settle()
  assert.ok(app.text().includes('剩余积分 123'))
  assert.ok(!app.text().includes('网络暂时断开'))
  const beforeEvent = app.calls.length
  app.events.get('ofm:channels')()
  await settle()
  assert.ok(app.calls.slice(beforeEvent).some(row => row.method === 'credits.balances'), '账号变化事件必须刷新余额')
  app.button('一键领取').props.onClick()
  await settle()
  assert.ok(app.text().includes('领取失败：签到凭据过期'), '后端领取失败不能伪装成无可领积分')
  app.cleanup()

  let resolveOld, resolveNew, readCount = 0
  const race = mount('qoder', async method => {
    if (method === 'credits.balances') {
      readCount++
      return new Promise(resolve => { if (readCount === 1) resolveOld = resolve; else resolveNew = resolve })
    }
    if (method === 'account.list') return { accounts: accountRows }
    if (method === 'credits.claimAll') return { summary: { claimed: 1, totalCredit: 100 }, results: [] }
    throw new Error(`意外的 RPC ${method}`)
  })
  const busyText = race.text()
  assert.ok(busyText.includes('余额查询中'))
  race.events.get('ofm:channels')()
  assert.equal(readCount, 1, '轮询和事件共用正在执行的只读请求')
  const claimButton = race.button('一键领取')
  claimButton.props.onClick()
  claimButton.props.onClick()
  await settle()
  assert.equal(race.calls.filter(row => row.method === 'credits.claimAll').length, 1, '重复点击不能重复领取')
  assert.equal(readCount, 2, '写入后必须查询新余额，不能复用写入前的在途请求')
  resolveNew({ accounts: [{ accountId: 'one', balance: { total: 456 } }] })
  await settle()
  resolveOld({ accounts: [{ accountId: 'one', balance: { total: 123 } }] })
  await settle()
  assert.ok(race.text().includes('456'))
  assert.ok(!race.text().includes('"123"'), '旧请求晚到不能覆盖新余额')
  race.cleanup()

  let resolveUnmount
  const unmounted = mount('qoder', async () => new Promise(resolve => { resolveUnmount = resolve }))
  unmounted.cleanup()
  resolveUnmount({ accounts: [{ accountId: 'one', balance: { total: 999 } }] })
  await settle()
  // ⚠️ 不能写死 `cells[下标]`：组件里每加一个 useState，后面的下标就整体右移，
  // 这条断言会变成一个与「卸载后不回写」毫无关系的数字比较（本次改动就踩到了
  // ——新增一个 claimByAccount 状态后 `cells[4]` 变成了另一个状态）。
  // 改为按语义判定：卸载后 `balances` 仍必须是 undefined（那次在飞请求的回写被丢弃）。
  assert.ok(
    !(unmounted.cells ?? []).some(cell => cell !== undefined && Array.isArray(cell) && cell.some?.(row => row?.accountId === 'one')),
    '卸载后不回写余额（晚到的响应不能落进 state）',
  )

  // 领取状态展示：**每个账号都必须有明确结论**，绝不静默留白。
  // 用户报障（2026-10-19）：raccoon 两个号，一个显示「今日已领300」，另一个空白，
  // 于是以为空白那个没领到（实际早上两个都领了）。空白来自三种不同情况，
  // 修好后必须分别显示，而不是都变成一片虚无。
  const statusRows = mount('raccoon', async method => {
    if (method === 'account.list') return { accounts: accountRows }
    if (method === 'credits.status') return { accounts: [
      { accountId: 'one', status: { todayCheckedIn: true, todayCredit: 300 } },
      { accountId: 'two', status: null, error: '状态查询失败（上游无响应或凭据失效）' },
    ] }
    if (method === 'credits.balances') return { accounts: accountRows.map(row => ({ accountId: row.id, balance: { total: 100 } })) }
    throw new Error(`意外的 RPC ${method}`)
  })
  await settle()
  statusRows.button('账号').props.onClick()
  await settle()
  assert.ok(statusRows.text().includes('今日已领 300'), '已领取账号必须显示已领')
  assert.ok(statusRows.text().includes('状态未知'), '状态查询失败的账号必须显示「状态未知」而不是空白')
  assert.ok(!statusRows.text().includes('今日未领'), '查询失败不能误报成「今日未领」')
  statusRows.cleanup()

  // 同一渠道里「今天还没领」也必须明确显示（而不是只显示已领的）。
  const notYet = mount('raccoon', async method => {
    if (method === 'account.list') return { accounts: accountRows }
    if (method === 'credits.status') return { accounts: [
      { accountId: 'one', status: { todayCheckedIn: true, todayCredit: 300 } },
      { accountId: 'two', status: { todayCheckedIn: false, todayCredit: 0 } },
    ] }
    if (method === 'credits.balances') return { accounts: accountRows.map(row => ({ accountId: row.id, balance: { total: 100 } })) }
    throw new Error(`意外的 RPC ${method}`)
  })
  await settle()
  notYet.button('账号').props.onClick()
  await settle()
  assert.ok(notYet.text().includes('今日已领 300'))
  assert.ok(notYet.text().includes('今日未领'), '未领取的账号必须显示「今日未领」')
  notYet.cleanup()

  // 已领但**缺 todayCredit**：必须显示「今日已领」（不带数字），
  // 绝不能掉到「今日未领」——把已领说成未领是最坏的错法（用户会去重复点领取）。
  // 真实后端当前不产生这种形态（todayCredit 是必填），这是防未来新渠道漏填的护栏。
  const creditMissing = mount('raccoon', async method => {
    if (method === 'account.list') return { accounts: [accountRows[0]] }
    if (method === 'credits.status') return { accounts: [
      { accountId: 'one', status: { todayCheckedIn: true } },
    ] }
    if (method === 'credits.balances') return { accounts: [{ accountId: 'one', balance: { total: 100 } }] }
    throw new Error(`意外的 RPC ${method}`)
  })
  await settle()
  creditMissing.button('账号').props.onClick()
  await settle()
  assert.ok(creditMissing.text().includes('今日已领'), '已领但缺 todayCredit 时仍必须显示已领')
  assert.ok(!creditMissing.text().includes('今日未领'), '绝不能把已领显示成未领')
  creditMissing.cleanup()

  // 没有状态接口的渠道（codearts / lobsterai / trae / cline / loomy）：
  // 显示能力缺失的说明，而不是故障文案。
  const noStatus = mount('codearts', async method => {
    if (method === 'account.list') return { accounts: [accountRows[0]] }
    // 后端对「没有状态接口」的渠道如实返回 unsupported: true（不是故障）。
    if (method === 'credits.status') return { accounts: [
      { accountId: 'one', status: null, unsupported: true },
    ] }
    if (method === 'credits.balances') return { accounts: [{ accountId: 'one', balance: { total: 100 } }] }
    if (method === 'credits.claimAll') return { summary: { claimed: 1, totalCredit: 1000 }, results: [
      { accountId: 'one', outcome: { kind: 'claimed', credit: 1000 } },
    ] }
    throw new Error(`意外的 RPC ${method}`)
  })
  await settle()
  noStatus.events.get('ofm:channels')()
  await settle()
  noStatus.button('账号').props.onClick()
  await settle()
  assert.ok(noStatus.text().includes('该渠道无状态接口'), '无状态接口的渠道要说清是能力缺失')
  // 点过领取之后，用那条 outcome 覆盖（比「无接口」更有信息量）。
  noStatus.button('一键领取').props.onClick()
  await settle()
  assert.ok(noStatus.text().includes('刚领取 +1000'), '点过领取后必须显示本次领取结果')

  // TRAE：上游 `used` 与差值法今日记录同屏对照（任务 D）。
  // 两个数字口径不同，必须**并列显示、不相减** —— 相减会产出「今日漏记 X」
  // 这种看似精确的假数字（理由是资源包周期累计 vs UTC+8 今日聚合）。
  const crossCheck = mount('trae', async method => {
    if (method === 'account.list') return { accounts: [accountRows[0]] }
    return { accounts: [{ accountId: 'one', balance: {
      total: 500,
      packages: [{ name: '每月登录赠送', remaining: 500, total: 1000, used: 500, active: true }],
    }, extra: {
      upstreamUsed: { total: 500, packages: 1, note: '上游自报已用量：按资源包周期累计' },
      recordedSpent: { spent: 12, note: '本插件按余额差值记录的今日消耗' },
    } }] }
  })
  await settle()
  crossCheck.button('账号').props.onClick()
  await settle()
  assert.ok(crossCheck.text().includes('上游累计已用 500'), '上游 used 必须显示')
  assert.ok(crossCheck.text().includes('今日差值 12'), '差值法今日消耗必须同屏显示')
  assert.ok(!crossCheck.text().includes('488'), '两个口径不能相减（500-12 是假数字）')
  crossCheck.cleanup()

  const quota = mount('gemini', async method => method === 'account.list'
    ? { accounts: [accountRows[0]] }
    : { accounts: [{ accountId: 'one', balance: { total: 60, packages: [{ name: '5 小时', remaining: 80 }, { name: '每周', remaining: 40 }] } }] })
  await settle()
  quota.button('账号').props.onClick()
  await settle()
  assert.ok(quota.text().includes('5 小时 80% · 每周 40%'), '不同配额窗口不能相加成积分')
  assert.ok(quota.text().includes('已查询 1 个账号'))
  quota.cleanup()
}

/**
 * 自执行入口（真实缺陷，2026-10-19 Tester 发现）。
 *
 * ## 为什么必须有
 *
 * 本文件此前**只导出** `verifyChannelCreditsUi`，没有自执行入口。于是：
 *
 * - `node scripts/channel-credits-ui-test.mjs` ⇒ 什么都不跑，**永远 EXIT=0**；
 * - 变异测试（故意把实现改回旧逻辑）在这里也会「通过」——假绿灯。
 *
 * 真实执行者只有一个：`scripts/channel-pack-test.mjs`（它 import 本函数）。
 * 但 `scripts/test-all.mjs` 的套件表把本文件**也**列为独立套件，于是
 * 「按文件名逐个跑」的 CI 会得到一次什么都没做的绿灯。
 *
 * 现在：被 import 时行为不变（不自动跑，由调用方决定时机）；**直接执行**时
 * 自己跑一遍并给出正确退出码。
 */
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (invokedDirectly) {
  try {
    await verifyChannelCreditsUi()
    console.log('channel-credits-ui: all ok')
    process.exitCode = 0
  } catch (error) {
    console.error(`channel-credits-ui: FAILED — ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
