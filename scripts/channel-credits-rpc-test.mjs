import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

/** 使用实际已打包 RPC，只提供账号池 ref，禁止真实网络与旧单凭据回退。 */
export async function verifyChannelCreditsRpc({ ctx, call, creds }) {
  const originalFetch = globalThis.fetch
  const providers = ['qoder', 'qodercn', 'loomy', 'minimax', 'lobsterai', 'zcode', 'gemini']
  let quotaRequests = 0, quotaFailed = true
  const originalResolve = ctx.credentials.resolve
  const resolvedRefs = []
  ctx.credentials.resolve = async ref => { resolvedRefs.push(ref); return originalResolve(ref) }
  try {
    for (const provider of providers) {
      const ref = `FIXTURE_CREDITS_${provider.toUpperCase()}`
      creds.set(ref, { value: JSON.stringify({
        access_token: 'fixture-credits-token', token_type: 'Bearer', user_id: 'fixture-user',
        zcode_jwt: 'fixture-credits-jwt', device_mid: 'fixture-device', account_label: '隔离账号',
      }) })
      await ctx.accountPool.addAccount({
        id: `fixture-credits-${provider}`, provider, nickname: '隔离账号',
        credentialRef: ref, enabled: true, refreshable: false, createdAt: 1,
      })
    }
    globalThis.fetch = async input => {
      const pathname = new URL(String(input)).pathname
      let body
      if (pathname.includes('get-user-resource')) {
        body = { code: 0, data: { Response: { Data: { Accounts: [{
          PackageName: 'fixture', CycleCapacityRemain: 123, Status: 1,
        }] } } } }
      } else if (pathname.includes('/me/usage')) {
        body = { qoderUsage: { userQuota: { total: 123, remaining: 123, used: 0, unit: 'credits' } } }
      } else if (pathname.includes('/points/records')) {
        body = { code: '000000', data: { balance: 123, dailyBalance: 0, availableBalance: 123 } }
      } else if (pathname.includes('/credit/details')) {
        body = { base_resp: { status_code: 0 }, total_count: 1, details: [{ remaining_amount: '123.00' }] }
      } else if (pathname.includes('/profile-summary')) {
        body = { code: 0, success: true, data: { totalCreditsRemaining: 123, creditItems: [] } }
      } else if (pathname.endsWith(':retrieveUserQuotaSummary')) {
        quotaRequests++
        if (quotaFailed) return new Response('本机配额查询失败', { status: 502 })
        body = { groups: [{ buckets: [
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: new Date(Date.now() + 3600000).toISOString() },
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: new Date(Date.now() + 86400000).toISOString() },
        ] }] }
      } else throw new Error(`未预期的替身端点：${pathname}`)
      return Response.json(body)
    }
    // ── credits.status：**每个支持领取的渠道，每个账号都要有明确状态** ──────
    // 用户报障（2026-10-19）：raccoon 两个号一个显示已领、一个空白，于是以为
    // 空白那个没领到。根因有两层：① 后端把 null 原样返回不给原因；
    // ② 前端只对能力表写了 `status: true` 的渠道发起查询，其余渠道**从不问**。
    // 这里锁定后端那一半：可领取但无状态接口的渠道必须明确回答 unsupported。
    //
    // ⚠️ 只断言**本夹具真的建了账号**的渠道（codearts / trae 的凭据形状不同，
    // 分别在别的套件里覆盖）；这里的目的是锁定「有账号就必须有一行状态」。
    const claimableWithoutStatus = ['lobsterai', 'qoder', 'qodercn', 'zcode']
    for (const provider of claimableWithoutStatus) {
      const result = await call('credits.status', { provider })
      assert.equal(result.ok, true, `${provider} 的 credits.status 不能报错（能力缺失不是错误）`)
      const row = (result.value.accounts ?? []).find(entry => entry.accountId === `fixture-credits-${provider}`)
      assert.ok(row !== undefined, `${provider} 必须为池里每个账号返回一行`)
      assert.equal(row.status, null)
      assert.equal(row.unsupported, true, `${provider} 必须标明「该渠道无状态接口」，而不是让前端以为是查询失败`)
    }
    // 未知 provider 仍然要被拒绝：不能因为「能领取」就把拼错的 id 也放过去。
    const bogus = await call('credits.status', { provider: 'no-such-provider' })
    assert.equal(bogus.ok, false, '未知 provider 必须 bad-request')

    for (const provider of providers.filter(id => id !== 'zcode' && id !== 'gemini')) {
      resolvedRefs.length = 0
      const result = await call('credits.balances', { provider })
      assert.equal(result.ok, true)
      assert.equal(result.value.accounts[0].balance?.total, 123, `${provider} 的账号池凭据应能查询余额`)
      assert.ok(resolvedRefs.includes(`FIXTURE_CREDITS_${provider.toUpperCase()}`))
    }
    assert.equal((await ctx.zcodeAuth.current()).zcode_jwt, 'fixture-credits-jwt')
    assert.equal((await ctx.zcodeAuth.status()).configured, true)
    creds.delete('FIXTURE_CREDITS_QODER')
    const missing = await call('credits.balances', { provider: 'qoder' })
    assert.equal(missing.value.accounts[0].balance, null)
    assert.equal(missing.value.accounts[0].error, '凭据未配置', '缺失凭据必须返回原因，不能伪造零余额')
    const unavailableQuota = await call('credits.balances', { provider: 'gemini' })
    assert.equal(unavailableQuota.value.accounts[0].balance, null)
    quotaFailed = false
    const cachedQuota = await call('credits.balances', { provider: 'gemini' })
    assert.equal(cachedQuota.value.accounts[0].balance, null)
    assert.equal(quotaRequests, 1, '自动查询保留原有缓存')
    const freshQuota = await call('credits.balances', { provider: 'gemini', force: true })
    assert.equal(quotaRequests, 2, '手动重试必须真正查询上游替身')
    assert.equal(freshQuota.value.accounts[0].balance.total, 60)
    await verifyRefreshDispatch({ ctx, call })
  } finally {
    ctx.credentials.resolve = originalResolve
    globalThis.fetch = originalFetch
    for (const provider of providers) {
      await ctx.accountPool.removeAccount(`fixture-credits-${provider}`)
      creds.delete(`FIXTURE_CREDITS_${provider.toUpperCase()}`)
    }
  }
}

async function verifyRefreshDispatch({ ctx, call }) {
  const providers = [
    'codearts', 'lobsterai', 'qoder', 'qodercn', 'trae',
    'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
  ]
  for (const provider of providers) {
    const service = ctx[`${provider}Auth`]
    assert.ok(service, `${provider} auth service is mounted`)
    const saved = service.refreshAccountCredential
    const accountId = `fixture-refresh-${provider}`, ref = `FIXTURE_REFRESH_${provider.toUpperCase()}`
    const calls = []
    try {
      await ctx.accountPool.addAccount({
        id: accountId, provider, nickname: 'offline-refresh', credentialRef: ref,
        enabled: false, refreshable: true, createdAt: 1,
      })
      service.refreshAccountCredential = async (...args) => { calls.push(args) }
      const result = await call('account.refresh', { accountId })
      assert.deepEqual(result, { ok: true, value: { success: true } }, provider)
      assert.equal(calls.length, 1, provider)
      assert.deepEqual(calls[0], [ref, ctx.accountPool, accountId], `${provider}: exact ref, pool and id`)
      service.refreshAccountCredential = async () => { throw new Error('offline refresh rejected') }
      const rejected = await call('account.refresh', { accountId })
      assert.equal(rejected.ok, false, `${provider}: refresh failure is not success`)
      assert.match(rejected.error.message, /offline refresh rejected/)
    } finally {
      service.refreshAccountCredential = saved
      await ctx.accountPool.removeAccount(accountId)
    }
  }
  console.log('ok  refresh RPC: all 11 providers pass exact ref/pool/id; disabled accounts refresh; failures return ok:false')
}

/**
 * 自执行入口（真实缺陷，2026-10-19）。
 *
 * 本函数需要宿主上下文（`{ ctx, call, creds }`），单独执行时**没有**现成的
 * 挂载实例可复用 —— 而它正是 `channel-pack-test.mjs` 的主体，自己再搭一套
 * 宿主既重复又容易漂移。
 *
 * 故这里的自执行入口**不假装跑过**：如实说明「需要宿主上下文，请经
 * channel-pack-test 运行」并给出**非零退出码**。假绿灯比不跑更危险 ——
 * 前者会让人以为覆盖到了。
 */
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (invokedDirectly) {
  console.error(
    'channel-credits-rpc: 本套件需要挂载好的宿主上下文（ctx / call / creds），\n'
    + '无法独立执行。请运行 `node scripts/channel-pack-test.mjs` 或 `npm run test`。',
  )
  process.exitCode = 2
}
