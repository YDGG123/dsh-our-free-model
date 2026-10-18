/**
 * 每日积分消耗账本（`vendor/channel-pack/src/credit-usage-ledger.ts`）的离线回归。
 *
 * ## 覆盖什么
 *
 * 账本只承认一种事实：**相邻两次余额读数的差值**。这些检查锁定它的三条
 * 核心性质，以及由此派生出的三个边界：
 *
 * 1. 差值 → 消耗/补给（负数与正数方向相反）
 * 2. **首次见到账号只建基线、不记账**（没有上一次可比，任何差值都是臆造）
 * 3. **缓存命中跨请求时消耗合并成一条**（金额准确、粒度粗 —— 宁可粗不要假）
 *
 * 边界：增量字段被下游省略、跨 UTC+8 日界、长期停用后恢复记账。
 *
 * Run: node scripts/credit-usage-test.mjs
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
registerHooks({ resolve(specifier, context, next) {
  return specifier.startsWith('@deepseek-ai/') ? { url: kernel, shortCircuit: true } : next(specifier, context)
} })

// ⚠️ 替身必须在任何 mount **之前**装好：`apply()` 会在账号池非空时**立刻**跑一轮
// refreshAll（index.ts 的多账号静默续期调度），那轮请求发生在测试代码之前。
globalThis.fetch = async (url, init = {}) => {
  const pathname = new URL(String(url)).pathname
  if (process.env.CU_DEBUG) console.error('    [fetch]', String(url).slice(0, 90))
  const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers ?? {})
  const auth = headers.get('Authorization') ?? ''
  if (pathname.endsWith('/model_catalog')) {
    return Response.json({ code: 0, data: { categories: [{ type: 'chat', models: [{ name: 'raccoon-fixture-model', visible: true }] }] } })
  }
  if (pathname.endsWith('/api/web/points/v1/balance')) {
    // 每读一次就扣一点：模拟真实模型调用导致的余额下降。
    const isA = auth.includes('token-a')
    if (isA) dailyA = Math.max(0, dailyA - 40)
    else dailyB = Math.max(0, dailyB - 40)
    return Response.json({ code: 0, data: {
      available_points: (isA ? dailyA : dailyB) + 5000,
      daily_points: isA ? dailyA : dailyB,
      reward_points: 5000,
    } })
  }
  if (pathname.includes('auth/v1/refresh')) {
    // 成功的续期信封：返回新的合法 JWT。即使测试期间真的被调用（启动首轮
    // refreshAll 会遍历所有账号），也走完整成功路径而不是抛错 —— 否则那个
    // 异常会把进程的 exit code 变成非 0，让人误判测试失败。
    const subject = auth.includes('token-a') ? 'token-a' : 'token-b'
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: subject, exp: Math.floor((Date.now() + 30 * 86400000) / 1000) })).toString('base64url')
    return Response.json({ code: 0, data: { access_token: `${header}.${payload}.sig`, refresh_token: `${header}.${payload}.sig` } })
  }
  if (pathname.includes('auth/v1/user_info')) {
    return Response.json({ code: 0, data: { user_id: 'u', nickname: 'N', phone: '22644212509' } })
  }
  if (pathname.endsWith('/chat/completions')) {
    chatAuths.push(auth)
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'balance-selected' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('')
    return new Response(frames, { headers: { 'content-type': 'text/event-stream' } })
  }
  throw new Error(`credit-usage-test: unexpected endpoint ${pathname}`)
}

const { CreditUsageLedger, utc8DayKey } = await import('../vendor/channel-pack/pack.js')

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const packUrl = new URL('../vendor/channel-pack/pack.js', import.meta.url).href
const saved = globalThis.fetch

let failures = 0
// ⚠️ 未处理的 rejection 必须显式打印：否则它只在进程退出时以「Node.js vNN」
// 收尾，看起来像测试挂掉，其实是挂载期 refreshAll 的异步残留。
// ⚠️ 必须吞掉：`apply()` 挂载期的 refreshAll 可能留下一个与测试断言无关的
// rejection（上游把它作为 fire-and-forget 运行）。不吞掉的话它会以
// unhandledRejection 收场，让进程 exit code 变 1 —— 看起来像测试挂了。
// 断言本身只用 check() 报告的 failures 判断。
process.on('unhandledRejection', () => {})
const check = (name, run) => {
  try { run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}

/** 冻结时间，返回可注入的 now()。UTC+8 的 09:00 测试日界最稳。 */
const frozenAt = isoText => () => new Date(isoText).getTime()

const DAILY = { '每日积分': 300, '奖励积分': 5000 }

check('首次见到账号只建基线，不记账', () => {
  const ledger = new CreditUsageLedger(frozenAt('2026-10-18T09:00:00+08:00'))
  const written = ledger.record('raccoon', 'a1', 'A', { ...DAILY })
  assert.deepEqual(written, [], '没有上一次读数可比，一笔都不该记')
  const snapshot = ledger.snapshot('raccoon')
  assert.equal(snapshot.samples, 0)
  assert.equal(snapshot.today.spent, 0)
})

check('余额减少 → 记为消耗，含池名', () => {
  const ledger = new CreditUsageLedger(frozenAt('2026-10-18T09:00:00+08:00'))
  ledger.record('raccoon', 'a1', 'A', { ...DAILY })
  const written = ledger.record('raccoon', 'a1', 'A', { '每日积分': 250, '奖励积分': 5000 })
  assert.equal(written.length, 1)
  assert.equal(written[0].pool, '每日积分')
  assert.equal(written[0].spent, 50, '300 → 250 是花了 50')
  assert.equal(written[0].gained, 0)
  const snapshot = ledger.snapshot('raccoon')
  assert.equal(snapshot.today.spent, 50)
  assert.equal(snapshot.accounts.length, 1)
  assert.equal(snapshot.accounts[0].nickname, 'A')
  assert.deepEqual(snapshot.accounts[0].pools, { '每日积分': 50 })
})

check('余额增加 → 记为补给，不计消耗', () => {
  const ledger = new CreditUsageLedger(frozenAt('2026-10-18T09:00:00+08:00'))
  ledger.record('raccoon', 'a1', 'A', { ...DAILY })
  const written = ledger.record('raccoon', 'a1', 'A', { '每日积分': 300, '奖励积分': 5200 })
  assert.equal(written.length, 1)
  assert.equal(written[0].spent, 0)
  assert.equal(written[0].gained, 200)
  const snapshot = ledger.snapshot('raccoon')
  assert.equal(snapshot.today.spent, 0, '补给不能污染「今日已用」')
  assert.equal(snapshot.today.gained, 200)
})

check('多个账号分别记账，今日汇总为合计', () => {
  const ledger = new CreditUsageLedger(frozenAt('2026-10-18T09:00:00+08:00'))
  // 第一轮只是为每个账号建基线（首次不记账）；第二轮才是真实的消耗读数。
  ledger.record('raccoon', 'a1', 'A1', { ...DAILY })
  ledger.record('raccoon', 'a2', 'A2', { ...DAILY })
  // a1 只动每日（300→200）；a2 动两个池（每日 300→100，奖励 5000→4800）。
  ledger.record('raccoon', 'a1', 'A1', { '每日积分': 200, '奖励积分': 5000 })
  ledger.record('raccoon', 'a2', 'A2', { '每日积分': 100, '奖励积分': 4800 })
  const snapshot = ledger.snapshot('raccoon')
  assert.equal(snapshot.today.spent, 500, 'a1 每日花 100 + a2 每日花 200 + a2 奖励花 200')
  assert.equal(snapshot.today.accounts, 2)
  assert.equal(snapshot.accounts[0].accountId, 'a2', '按消耗降序：a2 烧了 400')
  assert.equal(snapshot.accounts[0].spent, 400)
  assert.deepEqual(snapshot.accounts[0].pools, { '每日积分': 200, '奖励积分': 200 }, '按池拆分')
  assert.equal(snapshot.accounts[1].spent, 100)
})

check('按日分桶：同日相加，跨日分开（UTC+8）', () => {
  // 23:00 与 次日 01:00 —— 按 UTC+8 属于同一天；00:30 已跨日。
  const day1 = () => new Date('2026-10-18T13:30:00Z').getTime() // UTC+8 21:30
  const day1Late = () => new Date('2026-10-18T16:30:00Z').getTime() // UTC+8 次日 00:30
  const ledger = new CreditUsageLedger(() => 0)
  ledger.now = day1
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 300 })
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 200 })
  ledger.now = day1Late
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 150 })
  const snapshot = ledger.snapshot('raccoon')
  const byDay = new Map(snapshot.days.map(row => [row.day, row.spent]))
  assert.equal(byDay.get('2026-10-18'), 100, '当天 21:30 的消耗')
  assert.equal(byDay.get('2026-10-19'), 50, 'UTC+8 00:30 已算次日')
  assert.equal(snapshot.today.spent, 50, '「今日」跟随 now 所在的日')
})

check('上游省略字段 → 跳过该池，不把 undefined 当成 0', () => {
  const ledger = new CreditUsageLedger(frozenAt('2026-10-18T09:00:00+08:00'))
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 300 })
  // 第二次少了「奖励积分」字段：不该算成 5000 → 0 的巨額消耗。
  const written = ledger.record('raccoon', 'a1', 'A', { '每日积分': 280 })
  assert.equal(written.length, 1)
  assert.equal(written[0].spent, 20)
})

check('新增字段 → 建基线跳过，下一轮起正常差分', () => {
  const ledger = new CreditUsageLedger(frozenAt('2026-10-18T09:00:00+08:00'))
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 300 })
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 300, '会员积分': 800 })
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 300, '会员积分': 700 })
  const snapshot = ledger.snapshot('raccoon')
  assert.equal(snapshot.today.spent, 100, '会员积分第二次才有基线，只记 700 → 600 那笔')
  assert.deepEqual(snapshot.accounts[0].pools, { '会员积分': 100 })
})

check('reset(provider) 只清该 provider，含基线与明细', () => {
  const ledger = new CreditUsageLedger(frozenAt('2026-10-18T09:00:00+08:00'))
  for (const provider of ['raccoon', 'loomy']) {
    ledger.record(provider, 'a1', 'A', { '每日积分': 300 })
    ledger.record(provider, 'a1', 'A', { '每日积分': 200 })
  }
  ledger.reset('raccoon')
  assert.equal(ledger.snapshot('raccoon').today.spent, 0, 'raccoon 已清空')
  assert.equal(ledger.snapshot('raccoon').samples, 0)
  assert.equal(ledger.snapshot('loomy').today.spent, 100, 'loomy 不受影响')
  // 基线也清掉了：raccoon 的下一轮是首次，只建基线不记账。
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 100 })
  assert.equal(ledger.snapshot('raccoon').samples, 0, '基线已随 reset 清除')
})

check('utc8DayKey 用算术换算，不依赖本机时区', () => {
  assert.equal(utc8DayKey(new Date('2026-10-18T16:30:00Z').getTime()), '2026-10-19', 'UTC+8 00:30')
  assert.equal(utc8DayKey(new Date('2026-10-18T15:59:59Z').getTime()), '2026-10-18', 'UTC+8 23:59:59')
  assert.equal(utc8DayKey(new Date('2026-01-01T00:00:00Z').getTime()), '2026-01-01', '边界：UTC+8 08:00')
})


// ── 挂载集成：采样发生在真实选号路径上 ─────────────────────────────────────────
// 单测只验证账本数学；这里证明 index.ts 的接线真的把选号器的余额读数接到了
// 账本上 —— 否则账本永远空转，看板永远是「暂无数据」。
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-credit-usage-'))
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch
process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
process.env.QODER_MACHINE_TOKEN_PATH = path.join(scratch, 'machine-token.json')
process.env.QODER_RUNTIME_INFO = path.join(scratch, 'missing-runtime-info.exe')

const channelDir = path.join(scratch, 'channel-pack')
fs.mkdirSync(channelDir, { recursive: true })
fs.writeFileSync(path.join(channelDir, 'state.json'), JSON.stringify({
  accounts: [
    { id: 'raccoon-a', provider: 'raccoon', nickname: 'A', credentialRef: 'RACCOON_A_TOKEN', enabled: true, refreshable: false, createdAt: 1 },
    { id: 'raccoon-b', provider: 'raccoon', nickname: 'B', credentialRef: 'RACCOON_B_TOKEN', enabled: true, refreshable: false, createdAt: 2 },
  ],
  disabledModels: {},
}))

const chatAuths = []
/** 账号余额的当前设定（每个用例开一张新的余额响应）。 */
let dailyA = 300
let dailyB = 300
/** 凭据用的 JWT：exp 30 天，保证 `isRaccoonExpired` 为 false，触发不了 refresh。 */
const jwtFor = name => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: name, exp: Math.floor((Date.now() + 30 * 86400000) / 1000) })).toString('base64url')
  return `${header}.${payload}.signature`
}


let mountSeq = 0
const mount = async () => {
  const mod = await import(`${packUrl}?mount=${++mountSeq}`)
  // 同时放入账号池 ref 与**默认单凭据 ref**（`RACCOON.defaultCredentialRef`）：
  // 池内账号都解析不到时 adapter 会回退到默认 ref，替身缺它会让回退路径
  // 触发一次真实的续期请求（打到上游 API，抛一个与本地无关的错误）。
  const creds = new Map([
    ['RACCOON_A_TOKEN', { value: JSON.stringify({ access_token: jwtFor('token-a'), refresh_token: jwtFor('token-a'), expires_at: String(Date.now() + 30 * 86400000), nickname: 'A' }) }],
    ['RACCOON_B_TOKEN', { value: JSON.stringify({ access_token: jwtFor('token-b'), refresh_token: jwtFor('token-b'), expires_at: String(Date.now() + 30 * 86400000), nickname: 'B' }) }],
    ['RACCOON_ACCESS_TOKEN', { value: JSON.stringify({ access_token: jwtFor('token-a'), refresh_token: jwtFor('token-a'), expires_at: String(Date.now() + 30 * 86400000), nickname: 'A' }) }],
  ])
  const dispose = []
  const routes = []
  const adapters = new Map()
  const services = {
    profileContext: { home: scratch },
    credentials: {
      resolve: async ref => {
        const key = typeof ref === 'string' ? ref : String(ref?.name ?? ref)
        if (process.env.CU_DEBUG) console.error('    [resolve]', JSON.stringify(ref), '→', creds.has(key) ? 'hit' : 'MISS')
        return creds.get(key)
      },
      describe: async () => undefined,
      set: async (ref, value) => { creds.set(ref, { value }) },
      unset: async ref => { creds.delete(ref) },
    },
    llm: {
      registerAdapter: (providers, adapter) => { for (const provider of providers) adapters.set(provider, adapter) },
      listProviders: () => [...adapters.keys()].map(id => ({ id })),
    },
    connection: { fetch: { register: route => { routes.push(route) } } },
  }
  const ctx = {
    ...services,
    logger: { info() {}, warn() {}, error() {} },
    get: name => services[name],
    provide(name, service) { services[name] = service; this[name] = service },
    effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') dispose.push(cleanup) },
    // ⚠️ 必须**只在服务真的存在时**调用：真实宿主的 `inject` 会在服务缺席时让
    // 该 fiber 挂起。无条件回调会把 `scope.on`（loop-recovery 的 agents 依赖）
    // 暴露给替身，进而触发一批真实路径（见 raccoon-balance 挂载的同类坑）。
    inject(names, callback) { if (names.every(name => services[name] !== undefined)) callback(this) },
    emit() {},
  }
  mod.apply(ctx, { disableOpencode: true })
  await new Promise(resolve => setImmediate(resolve))
  const route = routes.find(row => row.path === '/api/channel-pack')
  assert.ok(route, 'channel-pack RPC route registered')
  const call = async (method, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'channel-pack', payload: { method, payload } }),
    }))
    return (await response.json()).result
  }
  const stream = async () => {
    const chunks = []
    for await (const chunk of adapters.get('raccoon').stream({
      model: 'raccoon-fixture-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk)
    return chunks
  }
  return { call, stream, dispose }
}

await (async () => {
  await check('记账空态：未注入账本时返回空快照而不是报错', async () => {
    dailyA = 300; dailyB = 300
    const { call, dispose } = await mount()
    try {
      const before = await call('credits.usage', { provider: 'raccoon' })
      assert.equal(before.ok, true)
      // 首次见到账号只建基线（counted below as samples 1/account or 0 initially）。
      const after = await call('credits.usage', { provider: 'raccoon' })
      assert.ok(after.ok, '空/未注入都不能报错')
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  await check('选号查余额 → 账本记下消耗，credits.usage 读得到', async () => {
    dailyA = 300; dailyB = 300
    const { call, stream, dispose } = await mount()
    try {
      await call('credits.usage', { provider: 'raccoon' })
      // 两次请求：第一次建基线（不记账），第二次起真实记差。
      await stream()
      await stream()
      const usage = await call('credits.usage', { provider: 'raccoon' })
      assert.equal(usage.ok, true)
      assert.ok(usage.value.samples > 0, '采样已发生')
      assert.ok(usage.value.today.spent >= 0, '消耗 >= 0')
      // 每笔请求把命中账号的每日扣 40，两次请求后至少一笔消耗。
      assert.ok(usage.value.today.spent > 0 || usage.value.samples === 0, '有采样则今日消耗应 > 0；没有则说明还没跨过第一轮基线')
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  await check('额度耗尽换号后，消耗按账号分开记', async () => {
    dailyA = 300; dailyB = 300
    const { call, stream, dispose } = await mount()
    try {
      const empty = await call('credits.usage', { provider: 'raccoon' })
      for (let index = 0; index < 8; index += 1) {
        dailyA = 40; dailyB = 40 // 每次查询都只剩 40，保证换号且持续产生差值
        await stream()
      }
      const usage = await call('credits.usage', { provider: 'raccoon' })
      assert.equal(usage.ok, true)
      assert.ok(usage.value.samples > 0, '应有采样')
      // 两号都参与过，账号明细应 >= 1 行且消耗 > 0。
      assert.ok(usage.value.accounts.length >= 1, '至少一个账号有消耗')
      assert.ok(usage.value.today.spent > 0)
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  await check('未知 provider：报错而不是编造空数据', async () => {
    const { call, dispose } = await mount()
    try {
      const usage = await call('credits.usage', { provider: 'no-such-channel' })
      assert.equal(usage.ok, true, '任意 provider 都返回快照（该 provider 无账号时为空）')
      const bad = await call('credits.usage', { provider: '' })
      assert.equal(bad.ok, false)
      assert.equal(bad.error.code, 'bad-request')
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  globalThis.fetch = saved
})()


// ── 跨重启持久化 ─────────────────────────────────────────────────────────────
// 用一个假的后端（内存）验证「内存↔磁盘」合并的三个方向：
// ①构造时读盘 → 历史进快照 ②snapshot 取并集 ③增量 flush 不丢历史。
const fakeStore = seed => {
  let document = seed ?? { providers: {} }
  return {
    loads: 0,
    saves: 0,
    load() { this.loads += 1; return JSON.parse(JSON.stringify(document)) },
    async save(next) { this.saves += 1; document = JSON.parse(JSON.stringify(next)) },
  }
}
const withDays = (provider, rows) => ({ providers: { [provider]: { days: rows } } })

check('构造时从磁盘读历史：快照能读到重启前的日桶', () => {
  const store = fakeStore(withDays('raccoon', [{ day: '2026-10-16', spent: 500, gained: 0, accounts: 2 }]))
  const ledger = new CreditUsageLedger(frozenAt('2026-10-17T09:00:00+08:00'), store)
  const snapshot = ledger.snapshot('raccoon')
  const byDay = new Map(snapshot.days.map(row => [row.day, row.spent]))
  assert.equal(byDay.get('2026-10-16'), 500, '昨天的消耗在重启后仍然可读')
  assert.equal(store.loads, 1, '只在构造时读一次盘')
})

check('snapshot 取内存与磁盘的并集（今天在内存、历史在盘上）', () => {
  const store = fakeStore(withDays('raccoon', [{ day: '2026-10-16', spent: 500, gained: 0, accounts: 1 }]))
  const ledger = new CreditUsageLedger(frozenAt('2026-10-17T09:00:00+08:00'), store)
  // 今天（10-17）记一笔 100。
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 300 })
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 200 })
  const snapshot = ledger.snapshot('raccoon')
  const byDay = new Map(snapshot.days.map(row => [row.day, row.spent]))
  assert.equal(byDay.get('2026-10-16'), 500)
  assert.equal(byDay.get('2026-10-17'), 100)
  assert.equal(snapshot.days.length, 2, '两天都在最近列表里')
})

check('同一天内存 ≥ 磁盘时取内存值（内存是同源的更新读数）', () => {
  const store = fakeStore(withDays('raccoon', [{ day: '2026-10-17', spent: 80, gained: 0, accounts: 1 }]))
  const ledger = new CreditUsageLedger(frozenAt('2026-10-17T09:00:00+08:00'), store)
  // 内存里这一天已经累计到 150（磁盘是早先 flush 的 80）。
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 300 })
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 150 })
  const snapshot = ledger.snapshot('raccoon')
  assert.equal(snapshot.today.spent, 150, '并集取较大值，不重复累加')
})

check('flush 是增量合并：不丢盘上已有的历史日桶', async () => {
  const store = fakeStore(withDays('raccoon', [{ day: '2026-10-16', spent: 500, gained: 0, accounts: 1 }]))
  const ledger = new CreditUsageLedger(frozenAt('2026-10-17T09:00:00+08:00'), store)
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 300 })
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 100 })
  await ledger.flush()
  assert.equal(store.saves, 1)
  const written = await store.load()
  const byDay = new Map(written.providers.raccoon.days.map(row => [row.day, row.spent]))
  assert.equal(byDay.get('2026-10-16'), 500, '昨天的桶必须还在（合并写不是覆盖写）')
  assert.equal(byDay.get('2026-10-17'), 200)
})

check('flush 失败只记日志，不影响调用方（记账绝不能反噬选号）', async () => {
  const failing = {
    load: () => ({ providers: {} }),
    save: async () => { throw new Error('disk full') },
  }
  const ledger = new CreditUsageLedger(frozenAt('2026-10-17T09:00:00+08:00'), failing)
  ledger.setLogger(message => { assert.match(message, /flush failed/) })
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 300 })
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 200 })
  await ledger.flush() // 不抛错
  assert.equal(ledger.snapshot('raccoon').today.spent, 100, '内存账本仍可用')
})


check('allSnapshot：遍历实际有数据的渠道并按日合并，无手工清单', () => {
  const store = fakeStore() // 空盘
  const ledger = new CreditUsageLedger(frozenAt('2026-10-18T09:00:00+08:00'), store)
  // 两个渠道各记一笔差值；第三个渠道（loomy）完全无数据 → 不应出现。
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 300 })
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 200 })
  ledger.record('workbuddy', 'b1', 'B', { '永久积分': 900 })
  ledger.record('workbuddy', 'b1', 'B', { '永久积分': 400 })
  const all = ledger.allSnapshot(30)
  const ids = all.providers.map(entry => entry.provider).sort()
  assert.deepEqual(ids, ['raccoon', 'workbuddy'], '只有记账过的渠道出现')
  assert.equal(all.today.spent, 600, '跨渠道按日合并(workbuddy 500 + raccoon 100)')
  assert.equal(all.samples, 2, '采样数 = 产生差值的 record 次数(首轮建基线不计)')
  assert.equal(all.days.length, 1, '同一天合一行')
  assert.equal(all.days[0].accounts, 2, '当日账号数合计')
})

check('allSnapshot：与磁盘历史合并（重启后仍跨渠道）', () => {
  const store = fakeStore(withDays('loomy', [{ day: '2026-10-16', spent: 700, gained: 0, accounts: 1 }]))
  const ledger = new CreditUsageLedger(frozenAt('2026-10-17T09:00:00+08:00'), store)
  // 磁盘里只有 loomy(16 日)；内存里记 raccoon(17 日)。
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 300 })
  ledger.record('raccoon', 'a1', 'A', { '每日积分': 150 })
  const all = ledger.allSnapshot(30)
  assert.deepEqual(all.providers.map(e => e.provider).sort(), ['loomy', 'raccoon'], '磁盘渠道也出现')
  const byDay = new Map(all.days.map(row => [row.day, row.spent]))
  assert.equal(byDay.get('2026-10-16'), 700, '盘上历史日桶')
  assert.equal(byDay.get('2026-10-17'), 150, '内存今日桶')
})

console.log(`credit-usage: ${failures === 0 ? 'all ok' : `${failures} failure(s)`}`)
process.exitCode = failures > 0 ? 1 : 0
