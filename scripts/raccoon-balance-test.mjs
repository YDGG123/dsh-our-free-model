/**
 * Raccoon 按余额优先选号 + 锁定长期积分的离线回归。
 *
 * ## 为什么需要这组检查
 *
 * Raccoon 的每日积分（每天自动发放）耗尽后，服务端**继续扣长期积分且不报错**
 * —— 「耗尽」是静默降级而非错误，既有的「限流 → 换号」机制对此无效：
 * 手动顺序第一位的号会一直烧长期积分，第二个号的每日额度原封不动地浪费。
 * `raccoon-balance-selector.ts` 因此在选号前按余额分档（每日 → 长期 → 无）。
 *
 * 锁定长期积分（`PERMANENT_LOCK_PROVIDERS` 含 RACCOON）则要求另一件事：
 * **锁上之后长期积分必须真的不参与选号** —— 排在队尾也会被调用方按顺序
 * 取到，锁定就形同虚设；且锁定落空时必须抛明确错误、绝不落到单凭据兜底。
 *
 * ## 两层覆盖
 *
 * - **选号器单测**：直接注入 fetch / now / TTL（依赖缝就是为此设计的），
 *   覆盖分档、锁定剔除、长期档排序、缓存 TTL 与「查不到 ≠ 用尽」。
 * - **挂载集成**：真实 pack.js 挂到宿主替身上，走完整的
 *   `adapter.stream → pickRaccoonAccount → select → 锁定报错` 链路，
 *   并用 RPC 验证白名单（raccoon 可锁 / 非 whitelist 渠道拒绝）。
 *   每个场景重新挂载一次 —— 选号器的余额缓存随适配器实例存活，
 *   跨场景复用会让上一个场景的余额读数泄漏到下一个。
 *
 * Run: node scripts/raccoon-balance-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier.startsWith('@deepseek-ai/') ? { url: kernel, shortCircuit: true } : next(specifier, context)
} })

let checks = 0
let failures = 0
const check = async (name, run) => {
  checks++
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`) }
}

// =====================================================================
// 第一部分：选号器单测（注入依赖，不发真实网络）
// =====================================================================

const packUrl = new URL('../vendor/channel-pack/pack.js', import.meta.url).href
const { RaccoonBalanceSelector } = await import(packUrl)

const unitProduct = { apiBase: 'https://raccoon.example', clientPlatform: 'desktop-macos', clientVersion: 'v1.0.35' }

/**
 * 造一个选号器 + 可检视的 fetch 记录。
 * `balances` 按 access_token（= credentialRef，测试里同名）给余额数据；
 * `failures` 里的 token 返回 code!=0 的信封（走「查询失败」路径）。
 */
const makeSelector = ({ balances, failures = [], now = () => 0, resolveCredential } = {}) => {
  const fetches = []
  const failTokens = new Set(failures)
  const fetcher = async (url, init = {}) => {
    const headers = init.headers ?? {}
    const token = String(headers.Authorization ?? '').replace('Bearer ', '')
    fetches.push({ url: String(url), token })
    assert.ok(String(url).includes('/api/web/points/v1/balance'), `余额应走 /points/v1/balance，实际 ${url}`)
    if (failTokens.has(token)) return Response.json({ code: 500, message: 'fixture failure' })
    const data = balances[token]
    assert.ok(data !== undefined, `替身未配置 ${token} 的余额`)
    return Response.json({ code: 0, data })
  }
  const selector = new RaccoonBalanceSelector({
    product: unitProduct,
    resolveCredential: resolveCredential ?? (async ref => ({ access_token: ref, refresh_token: `refresh-${ref}` })),
    fetcher,
    now,
  })
  return { selector, fetches }
}

const accounts = (...tokens) => tokens.map(token => ({ id: `id-${token}`, credentialRef: token }))
const ids = rows => rows.map(row => row.id)

try {
  await check('rank 解锁态分档：每日 → 长期 → 无余额，档内保持手动顺序', async () => {
    const { selector } = makeSelector({ balances: {
      'token-a': { available_points: 500, daily_points: 0 },
      'token-b': { available_points: 300, daily_points: 300 },
      'token-c': { available_points: 0, daily_points: 0 },
    } })
    assert.deepEqual(
      ids(await selector.rank(accounts('token-a', 'token-b', 'token-c'))),
      ['id-token-b', 'id-token-a', 'id-token-c'],
    )
  })

  await check('rank 查询失败归最后一档（不当作可用，也不丢弃）', async () => {
    const { selector, fetches } = makeSelector({
      balances: { 'token-b': { available_points: 300, daily_points: 300 } },
      failures: ['token-a'],
    })
    assert.deepEqual(ids(await selector.rank(accounts('token-a', 'token-b'))), ['id-token-b', 'id-token-a'])
    assert.equal(fetches.length, 2, '两个账号各查一次')
  })

  await check('rank 锁定只留每日档：只剩长期/无余额的账号被剔除而不是排队尾', async () => {
    const { selector } = makeSelector({ balances: {
      'token-a': { available_points: 500, daily_points: 0 },
      'token-b': { available_points: 300, daily_points: 300 },
      'token-c': { available_points: 0, daily_points: 0 },
    } })
    assert.deepEqual(ids(await selector.rank(accounts('token-a', 'token-b', 'token-c'), { locked: true })), ['id-token-b'])
  })

  await check('select 锁定且全部查询失败 → unknown（查不到 ≠ 用尽）', async () => {
    const { selector } = makeSelector({ balances: {}, failures: ['token-a', 'token-b'] })
    const picked = await selector.select(accounts('token-a', 'token-b'), { locked: true })
    assert.equal(picked.ok, false)
    assert.equal(picked.reason.kind, 'unknown')
    assert.equal(picked.reason.errors.length, 2)
  })

  await check('select 锁定且每日积分确实全为 0 → exhausted', async () => {
    const { selector } = makeSelector({ balances: {
      'token-a': { available_points: 500, daily_points: 0 },
      'token-b': { available_points: 0, daily_points: 0 },
    } })
    const picked = await selector.select(accounts('token-a', 'token-b'), { locked: true })
    assert.equal(picked.ok, false)
    assert.deepEqual(picked.reason, { kind: 'exhausted' })
  })

  await check('select 解锁态余额全 0 仍返回第一个候选（让上游报余额不足）', async () => {
    const { selector } = makeSelector({ balances: {
      'token-a': { available_points: 0, daily_points: 0 },
      'token-b': { available_points: 0, daily_points: 0 },
    } })
    const picked = await selector.select(accounts('token-a', 'token-b'))
    assert.equal(picked.ok, true)
    assert.equal(picked.account.id, 'id-token-a')
    assert.equal(picked.balance.totalBalance, 0)
  })

  await check('longTermOrder 默认 manual：长期档保持手动拖拽顺序', async () => {
    const balances = {
      'token-a': { available_points: 100, daily_points: 0 },
      'token-b': { available_points: 500, daily_points: 0 },
      'token-c': { available_points: 300, daily_points: 0 },
    }
    const { selector } = makeSelector({ balances })
    assert.deepEqual(ids(await selector.rank(accounts('token-a', 'token-b', 'token-c'))), ['id-token-a', 'id-token-b', 'id-token-c'])
  })

  await check("longTermOrder 'descending'：长期档按余额降序，并列回退手动顺序", async () => {
    const balances = {
      'token-a': { available_points: 100, daily_points: 0 },
      'token-b': { available_points: 500, daily_points: 0 },
      'token-c': { available_points: 300, daily_points: 0 },
      'token-d': { available_points: 500, daily_points: 0 },
    }
    const { selector } = makeSelector({ balances })
    assert.deepEqual(
      ids(await selector.rank(accounts('token-a', 'token-b', 'token-c', 'token-d'), { longTermOrder: 'descending' })),
      ['id-token-b', 'id-token-d', 'id-token-c', 'id-token-a'],
    )
  })

  await check('longTermFirst：指定账号排在长期档最前，其余保持手动顺序', async () => {
    const balances = {
      'token-a': { available_points: 500, daily_points: 0 },
      'token-b': { available_points: 300, daily_points: 0 },
      'token-c': { available_points: 700, daily_points: 0 },
    }
    const { selector } = makeSelector({ balances })
    assert.deepEqual(
      ids(await selector.rank(accounts('token-a', 'token-b', 'token-c'), { longTermFirst: 'id-token-b' })),
      ['id-token-b', 'id-token-a', 'id-token-c'],
      'B 被指定为优先 → 长期档内 B 先烧，A/C 保持手动顺序',
    )
  })

  await check('longTermFirst 不改档位判定：优先账号还有每日积分时仍走每日档', async () => {
    const balances = {
      'token-a': { available_points: 500, daily_points: 300 },
      'token-b': { available_points: 900, daily_points: 0 },
    }
    const { selector } = makeSelector({ balances })
    // 指定 B（只有长期）→ A 的每日档仍在最前（档位优先于档内偏好）。
    assert.deepEqual(ids(await selector.rank(accounts('token-a', 'token-b'), { longTermFirst: 'id-token-b' })), ['id-token-a', 'id-token-b'])
    // 指定 A（在每日档）→ 不把 B 提前，A 仍在档 0。
    assert.deepEqual(ids(await selector.rank(accounts('token-a', 'token-b'), { longTermFirst: 'id-token-a' })), ['id-token-a', 'id-token-b'])
  })

  await check('longTermFirst 不在候选里：安全回退手动顺序', async () => {
    const balances = {
      'token-a': { available_points: 500, daily_points: 0 },
      'token-b': { available_points: 300, daily_points: 0 },
    }
    const { selector } = makeSelector({ balances })
    assert.deepEqual(ids(await selector.rank(accounts('token-a', 'token-b'), { longTermFirst: 'id-ghost' })), ['id-token-a', 'id-token-b'])
  })

  await check('longTermFirst 优先于 longTermOrder descending', async () => {
    const balances = {
      'token-a': { available_points: 100, daily_points: 0 },
      'token-b': { available_points: 300, daily_points: 0 },
      'token-c': { available_points: 900, daily_points: 0 },
    }
    const { selector } = makeSelector({ balances })
    assert.deepEqual(
      ids(await selector.rank(accounts('token-a', 'token-b', 'token-c'), { longTermFirst: 'id-token-a', longTermOrder: 'descending' })),
      ['id-token-a', 'id-token-c', 'id-token-b'],
      '显式指定的 A 置前，其余按余额降序（C > B）',
    )
  })

  await check('每日积分字段缺失按长期档处理（不编造「有今日额度」）', async () => {
    const { selector } = makeSelector({ balances: {
      'token-a': { available_points: 500 },
      'token-b': { available_points: 300, daily_points: 300 },
    } })
    assert.deepEqual(ids(await selector.rank(accounts('token-a', 'token-b'))), ['id-token-b', 'id-token-a'])
    assert.deepEqual(ids(await selector.rank(accounts('token-a', 'token-b'), { locked: true })), ['id-token-b'])
  })

  await check('缓存：成功读数 60 秒内复用，过期重查', async () => {
    let t = 0
    const { selector, fetches } = makeSelector({ balances: { 'token-a': { available_points: 9, daily_points: 9 } }, now: () => t })
    await selector.rank(accounts('token-a'))
    await selector.rank(accounts('token-a'))
    assert.equal(fetches.length, 1, 'TTL 内第二次选号不应重新查余额')
    t = 60_000
    await selector.rank(accounts('token-a'))
    assert.equal(fetches.length, 2, '满 60 秒后应重查')
  })

  await check('缓存：查询失败只缓存 5 秒（一次抖动不伪装成额度用尽一分钟）', async () => {
    let t = 0
    const { selector, fetches } = makeSelector({ balances: {}, failures: ['token-a'], now: () => t })
    await selector.rank(accounts('token-a'))
    t = 4_000
    await selector.rank(accounts('token-a'))
    assert.equal(fetches.length, 1, '失败条目 5 秒内仍走缓存')
    t = 5_000
    await selector.rank(accounts('token-a'))
    assert.equal(fetches.length, 2, '满 5 秒应重查失败账号')
  })

  await check('invalidate 指定账号后立即重查（每日→长期边界只漏一个请求）', async () => {
    const { selector, fetches } = makeSelector({ balances: { 'token-a': { available_points: 9, daily_points: 9 } } })
    await selector.rank(accounts('token-a'))
    selector.invalidate('id-token-a')
    await selector.rank(accounts('token-a'))
    assert.equal(fetches.length, 2)
  })

  await check('凭据不可解析 → ok:false 条目归最后一档（不中断其余账号）', async () => {
    const { selector } = makeSelector({
      balances: { 'token-b': { available_points: 300, daily_points: 300 } },
      resolveCredential: async ref => (ref === 'token-a' ? undefined : { access_token: ref, refresh_token: 'r' }),
    })
    assert.deepEqual(ids(await selector.rank(accounts('token-a', 'token-b'))), ['id-token-b', 'id-token-a'])
    const entry = await selector.balanceOf({ id: 'id-token-a', credentialRef: 'token-a' })
    assert.equal(entry.ok, false)
    assert.ok(entry.error.includes('凭据未配置'))
  })

  // =====================================================================
  // 第二部分：挂载集成（真实 pack.js + 宿主替身 + 按场景可换的余额替身）
  // =====================================================================

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-raccoon-balance-'))
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
  const writeLocks = locked => fs.writeFileSync(
    path.join(channelDir, 'permanent-locks.json'),
    JSON.stringify(locked ? { raccoon: true } : {}),
  )
  const credential = (token, name) => JSON.stringify({
    access_token: token,
    refresh_token: `refresh-${token}`,
    expires_at: String(Date.now() + 86400000),
    user_id: `user-${name}`,
    nickname: name,
  })

  const savedFetch = globalThis.fetch
  /** 余额场景：mixed（B 有每日）/ noDaily（都只剩长期）/ aFails（A 查不到）。 */
  let balanceMode = 'mixed'
  const chatRequests = []
  const balancePayload = token => {
    if (balanceMode === 'aFails') {
      // A 查询失败（信封 code!=0）；B 查到了但每日/长期都是 0。
      return token === 'token-a'
        ? { code: 500, message: 'fixture failure' }
        : { code: 0, data: { available_points: 0, daily_points: 0 } }
    }
    if (balanceMode === 'noDaily') return { code: 0, data: { available_points: token === 'token-a' ? 500 : 300, daily_points: 0 } }
    return {
      code: 0,
      data: token === 'token-a'
        ? { available_points: 500, daily_points: 0, reward_points: 500 }
        : { available_points: 300, daily_points: 300 },
    }
  }
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname
    const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers ?? {})
    const auth = headers.get('Authorization') ?? ''
    if (pathname.endsWith('/model_catalog')) {
      return Response.json({ code: 0, data: { categories: [{ type: 'chat', models: [{ name: 'raccoon-fixture-model', visible: true }] }] } })
    }
    if (pathname.endsWith('/points/v1/balance')) return Response.json(balancePayload(auth.replace('Bearer ', '')))
    if (pathname.endsWith('/chat/completions')) {
      chatRequests.push(auth)
      const frames = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'balance-selected' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`,
        'data: [DONE]\n\n',
      ].join('')
      return new Response(frames, { headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`raccoon-balance-test: 未预期的替身端点 ${pathname}`)
  }

  let mountSeq = 0
  const mount = async () => {
    const mod = await import(`${packUrl}?mount=${++mountSeq}`)
    const creds = new Map([
      ['RACCOON_A_TOKEN', { value: credential('token-a', 'A') }],
      ['RACCOON_B_TOKEN', { value: credential('token-b', 'B') }],
    ])
    const dispose = []
    const routes = []
    const adapters = new Map()
    const services = {
      profileContext: { home: scratch },
      credentials: {
        resolve: async ref => creds.get(ref),
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
      inject(names, callback) { if (names.every(name => services[name] !== undefined)) callback(this) },
      emit() {},
    }
    mod.apply(ctx, { disableOpencode: true })
    await new Promise(resolve => setImmediate(resolve))
    const route = routes.find(row => row.path === '/api/channel-pack')
    assert.ok(route, 'channel-pack RPC 路由已注册')
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

  await check('RPC 白名单：raccoon 可锁定/回读，非白名单 provider 被拒', async () => {
    writeLocks(false)
    const { call } = await mount()
    const set = await call('credits.permanentLock', { provider: 'raccoon', locked: true })
    assert.equal(set.ok, true)
    assert.equal(set.value.locked, true)
    assert.equal(set.value.provider, 'raccoon')
    const read = await call('credits.permanentLock', { provider: 'raccoon' })
    assert.equal(read.ok, true)
    assert.equal(read.value.locked, true, '省略 locked 时只读回显')
    const rejected = await call('credits.permanentLock', { provider: 'trae', locked: true })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error.code, 'bad-request')
  })

  await check('余额优先选号：手动第一无每日额度时，改用有每日积分的号发请求', async () => {
    writeLocks(false)
    balanceMode = 'mixed'
    const { stream, dispose } = await mount()
    try {
      const chunks = await stream()
      assert.ok(JSON.stringify(chunks).includes('balance-selected'), '选中的号应完成推理')
      assert.equal(chatRequests.at(-1), 'Bearer token-b', '应选中 B（有每日积分），而不是手动第一的 A')
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  await check('锁定不拦每日档：有每日积分的号在锁定下照常可用', async () => {
    writeLocks(true)
    balanceMode = 'mixed'
    const { stream, dispose } = await mount()
    try {
      const chunks = await stream()
      assert.ok(JSON.stringify(chunks).includes('balance-selected'))
      assert.equal(chatRequests.at(-1), 'Bearer token-b', '锁定只排除长期档，B 的每日积分照常可用')
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  await check('锁定且每日全尽 → 明确报错，绝不落单凭据兜底、不发推理请求', async () => {
    writeLocks(true)
    balanceMode = 'noDaily'
    const { stream, dispose } = await mount()
    try {
      const before = chatRequests.length
      await assert.rejects(() => stream(), /已锁定长期积分，而所有账号的每日积分都已用尽/)
      assert.equal(chatRequests.length, before, '锁定落空时不应发出任何推理请求')
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  await check('锁定且有号查不到 → 报「无法确认」而不是「已用尽」', async () => {
    writeLocks(true)
    balanceMode = 'aFails'
    const { stream, dispose } = await mount()
    try {
      await assert.rejects(() => stream(), error => {
        assert.ok(/无法确认是否有可用账号/.test(error.message), error.message)
        assert.ok(/余额查询失败/.test(error.message), '报错要带上查询失败的事实')
        return true
      })
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  await check('解锁恢复长期积分：回到手动第一的号（只剩长期档）', async () => {
    writeLocks(false)
    balanceMode = 'noDaily'
    const { stream, dispose } = await mount()
    try {
      const chunks = await stream()
      assert.ok(JSON.stringify(chunks).includes('balance-selected'))
      assert.equal(chatRequests.at(-1), 'Bearer token-a', '解锁后每日/长期都可用，手动第一的 A 排在长期档首位')
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  await check('RPC：长期优先账号 读取/设置/清除/校验（非白名单与不存在账号被拒）', async () => {
    writeLocks(false)
    const { call, dispose } = await mount()
    try {
      const initial = await call('credits.longTermPreferred', { provider: 'raccoon' })
      assert.equal(initial.ok, true)
      assert.equal(initial.value.accountId, null, '未设置时回 null（跟随手动顺序）')
      const set = await call('credits.longTermPreferred', { provider: 'raccoon', accountId: 'raccoon-b' })
      assert.equal(set.ok, true)
      assert.equal(set.value.accountId, 'raccoon-b')
      const readBack = await call('credits.longTermPreferred', { provider: 'raccoon' })
      assert.equal(readBack.value.accountId, 'raccoon-b', '省略 accountId 的只读回显')
      const missing = await call('credits.longTermPreferred', { provider: 'raccoon', accountId: 'raccoon-ghost' })
      assert.equal(missing.ok, false)
      assert.equal(missing.error.code, 'bad-request')
      const rejected = await call('credits.longTermPreferred', { provider: 'trae', accountId: 'x' })
      assert.equal(rejected.ok, false)
      assert.equal(rejected.error.code, 'bad-request')
      const cleared = await call('credits.longTermPreferred', { provider: 'raccoon', accountId: null })
      assert.equal(cleared.ok, true)
      assert.equal(cleared.value.accountId, null)
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(scratch, 'channel-pack', 'long-term-preferred.json'), 'utf8')),
        { schema: 'dsh-codearts-auth/long-term-preferred/v1', preferred: {} },
        '清除后独立文档同步为空表')
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  await check('长期优先：每日用尽时先烧指定账号，清除后回到手动顺序', async () => {
    writeLocks(false)
    balanceMode = 'noDaily'
    const { call, stream, dispose } = await mount()
    try {
      await call('credits.longTermPreferred', { provider: 'raccoon', accountId: 'raccoon-b' })
      let chunks = await stream()
      assert.ok(JSON.stringify(chunks).includes('balance-selected'))
      assert.equal(chatRequests.at(-1), 'Bearer token-b', '每日用尽后，指定为优先的 B 先烧长期积分（而非手动第一的 A）')
      await call('credits.longTermPreferred', { provider: 'raccoon', accountId: null })
      chunks = await stream()
      assert.ok(JSON.stringify(chunks).includes('balance-selected'))
      assert.equal(chatRequests.at(-1), 'Bearer token-a', '清除优先后回到手动顺序（A 先烧）')
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  await check('长期优先：指定账号还有每日积分时不影响每日档的选号', async () => {
    writeLocks(false)
    balanceMode = 'mixed'
    const { call, stream, dispose } = await mount()
    try {
      // mixed：A 只剩长期，B 有每日。指定 A 为「长期优先」—— 但当前每日档
      // 由 B 提供，选号仍应走 B（档位判定优先于档内偏好）。
      await call('credits.longTermPreferred', { provider: 'raccoon', accountId: 'raccoon-a' })
      const chunks = await stream()
      assert.ok(JSON.stringify(chunks).includes('balance-selected'))
      assert.equal(chatRequests.at(-1), 'Bearer token-b')
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  await check('删除指定为长期优先的账号：偏好同步清除', async () => {
    writeLocks(false)
    const { call, dispose } = await mount()
    try {
      await call('credits.longTermPreferred', { provider: 'raccoon', accountId: 'raccoon-b' })
      const removed = await call('account.delete', { accountId: 'raccoon-b' })
      assert.equal(removed.ok, true)
      const after = await call('credits.longTermPreferred', { provider: 'raccoon' })
      assert.equal(after.value.accountId, null, '被删账号正是优先账号时，偏好随之清除（不留幽灵状态）')
    } finally { for (const cleanup of dispose.reverse()) await cleanup() }
  })

  globalThis.fetch = savedFetch
} finally {
  hooks.deregister()
}

console.log(`raccoon-balance: ${checks - failures}/${checks} ok`)
process.exitCode = failures > 0 ? 1 : 0
