/**
 * 发消息路径节流采样器（`vendor/channel-pack/src/credit-usage-sampler.ts`）的离线回归。
 *
 * ## 覆盖什么
 *
 * 采样器存在的唯一目的是「让八家只在开面板时记账的渠道，在发消息时也记一笔」，
 * 而它必须**绝不拖累主路径**。这几条性质一旦被破坏，后果分别是：
 *
 * 1. 不节流 ⇒ 每条消息多打一次上游请求（风控 + 延迟）；
 * 2. 按 provider 节流（而不是按账号）⇒ 多账号只有一个能记到账；
 * 3. 采样异常外泄 ⇒ 余额查询失败会变成发消息失败（最坏的一种回归）；
 * 4. 首次见账号就记账 ⇒ 把「当前余额」当成「刚花掉的钱」（假数字）。
 *
 * 另外锁定两处与面板路径的**同口径**：池的提取规则（只取 active 包）、
 * 以及「上游只给汇总数」时的兜底（MiniMax 的 `packages` 恒空）。
 *
 * Run: node scripts/credit-sampling-test.mjs
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
registerHooks({ resolve(specifier, context, next) {
  return specifier.startsWith('@deepseek-ai/') ? { url: kernel, shortCircuit: true } : next(specifier, context)
} })

let pack
 try { pack = await import('../vendor/channel-pack/pack.js') } catch (error) {
  throw new Error(`pack.js 加载失败（先跑 \`npm run channel-pack\`）：${error.message}`)
 }
 const { CreditUsageSampler, creditBalancePools } = pack
 if (typeof CreditUsageSampler !== 'function') throw new Error('pack.js 缺少导出的采样器 —— 先跑 `npm run channel-pack`')

let failures = 0
process.on('unhandledRejection', () => {})
const check = (name, run) => {
  try { run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}
const checkAsync = async (name, run) => {
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}

/** 可控时钟。 */
const clock = start => {
  let at = start
  return { now: () => at, advance: ms => { at += ms } }
}

const balanceOf = (packages, total = 0) => ({ total, packages, expiredTotal: 0 })
const pkg = (name, remaining, active = true) => ({
  name, unit: 'credits', remaining, total: remaining, used: 0, active,
  cycleStartTime: '', cycleEndTime: '', expiredTime: '',
})

// ── 节流 ─────────────────────────────────────────────────────────────────────

await checkAsync('节流窗口内只打一次上游；窗口过后再打', async () => {
  const time = clock(1_000_000)
  const records = []
  let reads = 0
  const sampler = new CreditUsageSampler({ record: (...args) => records.push(args), now: time.now, ttlMs: 60_000 })
  const read = async () => { reads += 1; return { '每日积分': 300 } }

  assert.equal(await sampler.sample('trae', 'a1', read), true)
  assert.equal(await sampler.sample('trae', 'a1', read), false, '60 秒内第二次必须被节流')
  assert.equal(reads, 1, '上游只被调用一次')
  time.advance(59_999)
  assert.equal(await sampler.sample('trae', 'a1', read), false, '差 1ms 仍在窗口内')
  time.advance(1)
  assert.equal(await sampler.sample('trae', 'a1', read), true, '满 60 秒后重新采样')
  assert.equal(reads, 2)
  assert.equal(records.length, 2, '两次采样各记一笔')
})

await checkAsync('节流键是 provider + accountId：多账号互不饿死', async () => {
  const time = clock(2_000_000)
  const records = []
  const sampler = new CreditUsageSampler({ record: (...args) => records.push(args), now: time.now, ttlMs: 60_000 })
  // 同一个 provider 下的三个账号，在**同一时刻**各采一次。
  for (const accountId of ['a1', 'a2', 'a3']) {
    assert.equal(await sampler.sample('trae', accountId, async () => ({ '每日积分': 300 })), true)
  }
  assert.equal(records.length, 3, '三个账号都必须记为一次')
  assert.deepEqual(records.map(row => row[1]), ['a1', 'a2', 'a3'])
  // 同一账号再次进入窗口 → 被节流，但不影响其它账号。
  assert.equal(await sampler.sample('trae', 'a1', async () => ({ '每日积分': 200 })), false)
})

await checkAsync('不同 provider 的同名账号互不影响', async () => {
  const time = clock(3_000_000)
  const records = []
  const sampler = new CreditUsageSampler({ record: (...args) => records.push(args), now: time.now, ttlMs: 60_000 })
  await sampler.sample('trae', 'shared-id', async () => ({ p: 1 }))
  assert.equal(await sampler.sample('qoder', 'shared-id', async () => ({ p: 1 })), true)
  assert.equal(records.length, 2)
})

await checkAsync('ttlMs = 0 表示不节流，每次都采', async () => {
  const time = clock(4_000_000)
  let reads = 0
  const sampler = new CreditUsageSampler({ record: () => {}, now: time.now, ttlMs: 0 })
  for (let index = 0; index < 3; index += 1) {
    await sampler.sample('trae', 'a1', async () => { reads += 1; return { p: 1 } })
  }
  assert.equal(reads, 3)
})

// ── 失败绝不影响主路径 ────────────────────────────────────────────────────────

await checkAsync('读取抛错 → 吞掉、记日志、不向外抛', async () => {
  const logs = []
  const timestamp = clock(5_000_000)
  const sampler = new CreditUsageSampler({
    record: () => { throw new Error('账本自己炸了也不能外泄') },
    now: timestamp.now,
    ttlMs: 0,
    warn: message => logs.push(message),
  })
  const outcome = await sampler.sample('trae', 'a1', async () => ({ p: 1 }))
  assert.equal(outcome, true, '调用方拿到的只是「发起过采样」，不会收到异常')
  assert.equal(logs.length, 1, '失败原因必须留下日志（否则线上什么都看不见）')
  assert.match(logs[0], /trae/)
  // 上游读取本身抛错同样被吞。
  await sampler.sample('trae', 'a2', async () => { throw new Error('network down') })
  assert.equal(logs.length, 2)
  assert.match(logs[1], /network down/)
})

await checkAsync('并发请求同一账号：只发一次上游请求', async () => {
  const time = clock(6_000_000)
  let reads = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const sampler = new CreditUsageSampler({ record: () => {}, now: time.now, ttlMs: 0 })
  const read = async () => { reads += 1; await gate; return { p: 1 } }
  const first = sampler.sample('trae', 'a1', read)
  const second = sampler.sample('trae', 'a1', read)
  release()
  assert.equal(await first, true)
  assert.equal(await second, false, '同一个在飞请求不再发一次')
  assert.equal(reads, 1)
})

await checkAsync('读取返回空/undefined → 不记账（不写空对象）', async () => {
  const records = []
  const time = clock(7_000_000)
  const sampler = new CreditUsageSampler({ record: (...args) => records.push(args), now: time.now, ttlMs: 0 })
  await sampler.sample('trae', 'a1', async () => undefined)
  await sampler.sample('trae', 'a2', async () => null)
  await sampler.sample('trae', 'a3', async () => ({}))
  assert.equal(records.length, 0)
})

// ── 与面板路径同口径：池的提取 ────────────────────────────────────────────────

check('只取 active 包；非 active / 非数字的包被忽略', () => {
  const pools = creditBalancePools(balanceOf([
    pkg('每日积分', 300),
    pkg('已失效', 999, false),
    { ...pkg('脏数据', 0), remaining: Number.NaN },
  ]))
  assert.deepEqual(pools, { '每日积分': 300 })
})

check('有包时不用汇总数（否则会双倍记账）', () => {
  const pools = creditBalancePools(balanceOf([pkg('每日积分', 300)], 300))
  assert.deepEqual(pools, { '每日积分': 300 }, '汇总数与包之和不能同时入账')
})

check('空 packages 时退到汇总数（MiniMax 的 packages 恒空）', () => {
  const pools = creditBalancePools(balanceOf([], 1234))
  assert.deepEqual(pools, { 积分: 1234 })
  // 自定义池名（渠道可给它一个有意义的单位）。
  assert.deepEqual(creditBalancePools(balanceOf([], 50), '额度'), { 额度: 50 })
})

check('没有可用数字 → undefined（调用方跳过，不记 0）', () => {
  assert.equal(creditBalancePools(null), undefined)
  assert.equal(creditBalancePools(undefined), undefined)
  assert.equal(creditBalancePools(balanceOf([], Number.NaN)), undefined)
  assert.equal(creditBalancePools(balanceOf([pkg('x', 0, false)], Number.NaN)), undefined)
})

// ── 接线回归：八家必须都真的挂上采样 ──────────────────────────────────────────
// 采样器再好，漏挂一家就等于那家还在「只有开面板才记账」。这条检查读源码而不是
// 挂载实例：八家的鉴权夹具互不相同，逐个 mount 的代价远超收益，而「有没有挂」
// 恰好是一个静态可判的事实。
check('八家渠道的 resolveCredential 都挂了 creditSampler.sample', async () => {
  const fs = await import('node:fs')
  const source = fs.readFileSync(new URL('../vendor/channel-pack/src/index.ts', import.meta.url), 'utf8')
  const expected = ['codearts', 'LOBSTERAI.id', 'QODER.id', 'QODER_CN.id', 'TRAE.id', 'CLINE.id', 'MINIMAX.id', 'GEMINI.id', 'ZCODE.id']
  for (const id of expected) {
    const marker = id === 'codearts' ? "creditSampler.sample('codearts'" : `creditSampler.sample(${id}`
    assert.ok(source.includes(marker), `${id} 缺少采样挂载点`)
  }
  // gemini 必须绕过 60 秒配额缓存，否则节流窗口与缓存同量级 ⇒ 读数被缓存吃掉。
  assert.match(source, /fetchGeminiCreditBalance\(credential, GEMINI, \{ force: true \}\)/,
    'gemini 采样必须 force 绕缓存，否则拿不到真值')
  // opencode 无余额端点，按边界要求不挂。
  assert.ok(!source.includes('creditSampler.sample(OPENCODE'), 'opencode 不应挂采样（无余额端点）')
})

console.log(`credit-sampling: ${failures === 0 ? 'all ok' : `${failures} failure(s)`}`)
process.exitCode = failures > 0 ? 1 : 0
