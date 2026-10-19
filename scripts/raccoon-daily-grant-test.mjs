/**
 * Raccoon 每日积分领取离线单测。
 *
 * 覆盖：首次领取成功、今日已领不再打触发器、触发器失败如实报失败、
 * 账单核对失败如实报、UTC+8 日界。
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'

const ts = (await import('typescript')).default
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
  if (specifier.endsWith('.js') && context.parentURL?.includes('/vendor/channel-pack/src/')) {
    const tsUrl = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
    if (fs.existsSync(new URL(tsUrl))) return { url: tsUrl, shortCircuit: true }
  }
  return next(specifier, context)
}, load(url, context, next) {
  if (url.endsWith('.ts') && url.includes('/vendor/channel-pack/src/')) {
    const source = fs.readFileSync(new URL(url), 'utf8')
    return { format: 'module', source: ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: new URL(url).pathname,
    }).outputText, shortCircuit: true }
  }
  return next(url, context)
} })

const raccoonCredits = await import('../vendor/channel-pack/src/raccoon-credits.ts')
const { claimRaccoonDailyGrant, fetchRaccoonDailyGrantStatus, billDayKey, RACCOON_DAILY_GRANT_TRIGGER_PATH, RACCOON_DAILY_GRANT_BILL_LIMIT, RACCOON_DAILY_GRANT_MAX_PAGES } = raccoonCredits
const { utc8DayKey } = await import('../vendor/channel-pack/src/credit-usage-ledger.ts')

const product = { apiBase: 'https://raccoon.example', clientPlatform: 'desktop-windows', clientVersion: 'v1.0.35' }
const credential = { access_token: 'fixture-token', refresh_token: 'fixture-refresh' }

let checks = 0
let failures = 0
const check = async (name, run) => {
  checks++
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`) }
}

function todayUtc8() {
  return utc8DayKey(Date.now())
}

function makeBillItem(points, createdAt) {
  return { biz_type: 'daily_grant', event_name: '每日积分发放', points, created_at: createdAt }
}

function makeBillsResponse(items) {
  return { code: 0, data: { items } }
}

function billUrlMatcher(base) {
  return new RegExp(`^${base}/api/web/points/v1/bills\\?paging\\.limit=`)
}

try {
  await check('首次领取成功：先查账单为空，触发器 HTTP 200，再查账单有今日入账 → claimed', async () => {
    const fetches = []
    const fetcher = async (url, init = {}) => {
      fetches.push({ url: String(url), method: init.method ?? 'GET' })
      if (String(url).endsWith(RACCOON_DAILY_GRANT_TRIGGER_PATH)) {
        return Response.json({ code: 0, data: { point_grant_popups: [], point_grant_toast: null } })
      }
      if (billUrlMatcher(product.apiBase).test(String(url))) {
        // 第一次账单查询为空，触发后再查到今日入账
        const isFirstBill = fetches.filter(f => f.url.includes('/bills')).length === 1
        const items = isFirstBill
          ? []
          : [makeBillItem(300, `${todayUtc8()}T09:00:00+08:00`)]
        return Response.json(makeBillsResponse(items))
      }
      throw new Error(`unexpected url ${url}`)
    }
    const outcome = await claimRaccoonDailyGrant(product, credential, fetcher)
    assert.equal(outcome.kind, 'claimed')
    assert.equal(outcome.credit, 300)
    assert.equal(outcome.coversToday, undefined)
    assert.equal(fetches.length, 3)
    assert.equal(fetches[0].url.includes('/bills'), true)
    assert.equal(fetches[1].url.endsWith(RACCOON_DAILY_GRANT_TRIGGER_PATH), true)
    assert.equal(fetches[2].url.includes('/bills'), true)
  })

  await check('今日已领：首次账单即有入账 → 不打触发器，直接 already-claimed', async () => {
    const fetches = []
    const fetcher = async (url, init = {}) => {
      fetches.push({ url: String(url), method: init.method ?? 'GET' })
      if (billUrlMatcher(product.apiBase).test(String(url))) {
        return Response.json(makeBillsResponse([makeBillItem(300, `${todayUtc8()}T08:30:00+08:00`)]))
      }
      if (String(url).endsWith(RACCOON_DAILY_GRANT_TRIGGER_PATH)) {
        throw new Error('触发器不应被调用')
      }
      throw new Error(`unexpected url ${url}`)
    }
    const outcome = await claimRaccoonDailyGrant(product, credential, fetcher)
    assert.equal(outcome.kind, 'already-claimed')
    assert.ok(outcome.message.includes('今日已领取'))
    assert.equal(fetches.length, 1)
  })

  await check('触发器失败：触发器 HTTP 500，账单无今日入账 → failed 如实报', async () => {
    const fetches = []
    const fetcher = async (url, init = {}) => {
      fetches.push({ url: String(url), method: init.method ?? 'GET' })
      if (String(url).endsWith(RACCOON_DAILY_GRANT_TRIGGER_PATH)) {
        return Response.json({ code: 500, message: '触发器故障' }, { status: 200 })
      }
      if (billUrlMatcher(product.apiBase).test(String(url))) {
        return Response.json(makeBillsResponse([]))
      }
      throw new Error(`unexpected url ${url}`)
    }
    const outcome = await claimRaccoonDailyGrant(product, credential, fetcher)
    assert.equal(outcome.kind, 'failed')
    assert.ok(outcome.message.includes('触发器调用失败'))
    assert.equal(fetches.length, 3)
  })

  await check('账单核对失败：触发器成功但账单接口超时 → failed 且未冒充成功', async () => {
    const fetches = []
    const fetcher = async (url, init = {}) => {
      fetches.push({ url: String(url), method: init.method ?? 'GET' })
      if (String(url).endsWith(RACCOON_DAILY_GRANT_TRIGGER_PATH)) {
        return Response.json({ code: 0, data: {} })
      }
      if (billUrlMatcher(product.apiBase).test(String(url))) {
        throw new Error('账单接口超时')
      }
      throw new Error(`unexpected url ${url}`)
    }
    const outcome = await claimRaccoonDailyGrant(product, credential, fetcher)
    assert.equal(outcome.kind, 'failed')
    assert.equal(outcome.message, '未能确认今日入账')
  })

  await check('UTC+8 边界：账单里有昨天入账但今天没有 → failed', async () => {
    const yesterday = utc8DayKey(Date.now() - 24 * 60 * 60 * 1000)
    const fetcher = async (url) => {
      if (String(url).endsWith(RACCOON_DAILY_GRANT_TRIGGER_PATH)) {
        return Response.json({ code: 0, data: {} })
      }
      if (billUrlMatcher(product.apiBase).test(String(url))) {
        return Response.json(makeBillsResponse([makeBillItem(300, `${yesterday}T23:59:59+08:00`)]))
      }
      throw new Error(`unexpected url ${url}`)
    }
    const outcome = await claimRaccoonDailyGrant(product, credential, fetcher)
    assert.equal(outcome.kind, 'failed')
    assert.ok(outcome.message.includes('未能确认今日入账'))
  })

  await check('fetchDailyGrantStatus：今天有入账 → todayCheckedIn true', async () => {
    const fetcher = async (url) => {
      if (billUrlMatcher(product.apiBase).test(String(url))) {
        return Response.json(makeBillsResponse([makeBillItem(300, `${todayUtc8()}T10:00:00+08:00`)]))
      }
      throw new Error(`unexpected url ${url}`)
    }
    const status = await fetchRaccoonDailyGrantStatus(product, credential, fetcher)
    assert.ok(status)
    assert.equal(status.active, true)
    assert.equal(status.todayCheckedIn, true)
    assert.equal(status.todayCredit, 300)
    assert.deepEqual(status.checkinDates, [todayUtc8()])
  })

  await check('fetchDailyGrantStatus：今天无入账 → todayCheckedIn false', async () => {
    const fetcher = async (url) => {
      if (billUrlMatcher(product.apiBase).test(String(url))) {
        return Response.json(makeBillsResponse([]))
      }
      throw new Error(`unexpected url ${url}`)
    }
    const status = await fetchRaccoonDailyGrantStatus(product, credential, fetcher)
    assert.ok(status)
    assert.equal(status.todayCheckedIn, false)
    assert.equal(status.todayCredit, 0)
    assert.deepEqual(status.checkinDates, [])
  })

  await check('fetchDailyGrantStatus：账单失败 → null', async () => {
    const fetcher = async (url) => {
      if (billUrlMatcher(product.apiBase).test(String(url))) {
        return Response.json({ code: 500, message: '账单接口错误' })
      }
      throw new Error(`unexpected url ${url}`)
    }
    const status = await fetchRaccoonDailyGrantStatus(product, credential, fetcher)
    assert.equal(status, null)
  })

  // ── 账单时间戳的 UTC+8 归一（真实缺陷，2026-10-19） ────────────────────────
  // 用户报障：raccoon 两个号，一个显示「今日已领300」、另一个什么都不显示。
  // 根因之一是旧代码用 `created_at.slice(0, 10)` 与 UTC+8 的今天比较 —— 只要
  // 上游用 UTC 表达时间，UTC+8 的 00:00–08:00 入账就会被判成「昨天」。
  await check('billDayKey：UTC 时间戳按 UTC+8 归一（凌晨入账算今天）', async () => {
    // 2026-10-18T16:16:24Z === UTC+8 的 2026-10-19 00:16:24
    assert.equal(billDayKey('2026-10-18T16:16:24Z'), '2026-10-19', 'UTC 凌晨必须归到次日（UTC+8）')
    assert.equal(billDayKey('2026-10-19T00:16:24+08:00'), '2026-10-19', '带偏移的字符串直接按偏移解析')
    assert.equal(billDayKey('2026-10-18T15:59:59Z'), '2026-10-18', 'UTC+8 的 23:59:59 仍是当天')
    assert.equal(billDayKey('2026-10-18T16:00:00Z'), '2026-10-19', 'UTC+8 的 00:00:00 已跨日')
  })

  await check('billDayKey：无法解析时返回 undefined（不猜日期）', async () => {
    assert.equal(billDayKey(''), undefined)
    assert.equal(billDayKey('not-a-date'), undefined)
  })

  await check('今日入账用 UTC 时间戳表达时，status 仍判定为已领', async () => {
    // 构造「UTC 表达、但真实时刻是 UTC+8 今天凌晨」的一条入账。
    const nowMs = Date.now()
    // 取 UTC+8 今天 00:16 对应的 UTC 字符串：UTC+8 00:16 = UTC 前一天 16:16
    const shifted = new Date(nowMs + 8 * 3600e3)
    const utcMidnightish = Date.UTC(
      shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 0, 16, 0,
    ) - 8 * 3600e3
    const createdAt = new Date(utcMidnightish).toISOString() // 形如 ...Z
    assert.ok(createdAt.endsWith('Z'), '夹具必须是 UTC 形态')
    const fetcher = async (url) => {
      if (billUrlMatcher(product.apiBase).test(String(url))) {
        return Response.json(makeBillsResponse([makeBillItem(300, createdAt)]))
      }
      throw new Error(`unexpected url ${url}`)
    }
    const status = await fetchRaccoonDailyGrantStatus(product, credential, fetcher)
    assert.ok(status, 'status 不该是 null')
    assert.equal(status.todayCheckedIn, true, 'UTC 表达的今日凌晨入账必须算今天')
    assert.equal(status.todayCredit, 300)
  })

  // ── 账单窗口分页（真实缺陷，2026-10-19 真机抓到） ──────────────────────────
  // 旧实现只看第一页 20 条。早上刚入账时 +300 是第 1 条，在窗口内；用了一上午
  // 之后它被消耗流水挤到第 43 / 74 位 ⇒ 掉出窗口 ⇒ 状态显示成「今日未领」，
  // 而钱明明在账上。真机证据：0899 的 +300 在第 74 位、5173 在第 43 位。

  /** 造一条消耗账单（points 为负，不会计入入账）。 */
  const costItem = (index) => ({
    biz_type: 'model_call', event_name: '模型调用', points: -index, created_at: `${todayUtc8()}T12:00:00+08:00`,
  })

  /** 造一个按 offset/limit 分页的假账单服务；`grantAt` 是 1-based 位置。 */
  const billServer = (grantAt, options = {}) => {
    const total = options.total ?? 200
    const items = []
    for (let i = 1; i <= total; i += 1) {
      items.push(i === grantAt
        ? makeBillItem(300, `${todayUtc8()}T07:56:18+08:00`)
        : costItem(i))
    }
    const calls = []
    const fetcher = async (url) => {
      const text = String(url)
      if (text.endsWith(RACCOON_DAILY_GRANT_TRIGGER_PATH)) {
        return Response.json({ code: 0, data: {} })
      }
      if (!billUrlMatcher(product.apiBase).test(text)) throw new Error(`unexpected url ${text}`)
      const parsed = new URL(text)
      const limit = Number(parsed.searchParams.get('paging.limit'))
      const offset = Number(parsed.searchParams.get('paging.offset'))
      calls.push({ limit, offset })
      // ⚠️ 上游 `paging.total` 恒为 0（说谎），这里刻意照抄，防止实现依赖它。
      return Response.json({
        code: 0,
        data: { items: items.slice(offset, offset + limit), paging: { total: 0, limit, offset } },
      })
    }
    return { fetcher, calls }
  }

  for (const position of [3, 30, 74, 150]) {
    await check(`今日入账在第 ${position} 位（跨页）也能检出`, async () => {
      const { fetcher, calls } = billServer(position)
      const status = await fetchRaccoonDailyGrantStatus(product, credential, fetcher)
      assert.ok(status, 'status 不该是 null')
      assert.equal(status.todayCheckedIn, true, `第 ${position} 位的入账必须被找到`)
      assert.equal(status.todayCredit, 300)
      // 需要的页数：ceil(position / limit)
      const needed = Math.ceil(position / RACCOON_DAILY_GRANT_BILL_LIMIT)
      assert.ok(calls.length >= needed, `至少要翻 ${needed} 页，实际 ${calls.length}`)
      assert.ok(calls.length <= RACCOON_DAILY_GRANT_MAX_PAGES, '不得超过页数上限')
    })
  }

  await check('paging.total 恒为 0（上游说谎）不影响翻页', async () => {
    // 第 74 位：若实现相信 total=0 决定终止，只会翻 1 页从而漏掉。
    const { fetcher, calls } = billServer(74)
    const status = await fetchRaccoonDailyGrantStatus(product, credential, fetcher)
    assert.equal(status.todayCheckedIn, true)
    assert.ok(calls.length > 1, '必须翻过第一页（说明没被 total=0 骗停）')
  })

  await check('翻到某页不足 limit → 判定到头，不再多翻', async () => {
    // 只有 5 条：第一页就返回不足 100 条，必须只请求一页。
    const { fetcher, calls } = billServer(3, { total: 5 })
    const status = await fetchRaccoonDailyGrantStatus(product, credential, fetcher)
    assert.equal(status.todayCheckedIn, true)
    assert.equal(calls.length, 1, '不满一页就到底，不该继续翻')
  })

  await check('最旧一条已早于今天 → 提前退出，不再翻满', async () => {
    // 第一页 100 条全是昨天（倒序），说明今天的流水已经翻过 ⇒ 一页就够。
    const yesterday = utc8DayKey(Date.now() - 24 * 60 * 60 * 1000)
    let pages = 0
    const fetcher = async (url) => {
      const text = String(url)
      if (!billUrlMatcher(product.apiBase).test(text)) throw new Error(`unexpected url ${text}`)
      pages += 1
      const items = Array.from({ length: RACCOON_DAILY_GRANT_BILL_LIMIT }, (_, i) => ({
        biz_type: 'model_call', event_name: '模型调用', points: -i,
        created_at: `${yesterday}T12:00:00+08:00`,
      }))
      return Response.json({ code: 0, data: { items } })
    }
    const status = await fetchRaccoonDailyGrantStatus(product, credential, fetcher)
    assert.equal(status.todayCheckedIn, false, '昨天的不算今天')
    assert.equal(pages, 1, '本页最旧一条已早于今天 ⇒ 立即停止')
  })

  await check('页数上限生效：今天入账在第 400 位（超出上限）⇒ 如实报未找到', async () => {
    const { fetcher, calls } = billServer(400, { total: 500 })
    const logs = []
    const status = await fetchRaccoonDailyGrantStatus(
      product, credential, fetcher, message => logs.push(message),
    )
    assert.equal(status.todayCheckedIn, false, '超出上限就如实报未找到，不臆造')
    assert.equal(calls.length, RACCOON_DAILY_GRANT_MAX_PAGES, '必须停在页数上限')
    assert.equal(logs.length, 1, '必须留一行诊断（否则无法区分「真没领」与「流水太深」）')
    assert.match(logs[0], /仍未找到今日入账/)
  })

  await check('第一页就失败 → null（无法确认，不能说成未领）', async () => {
    const fetcher = async (url) => {
      if (!billUrlMatcher(product.apiBase).test(String(url))) throw new Error(`unexpected url ${url}`)
      return Response.json({ code: 500, message: '账单接口错误' })
    }
    const status = await fetchRaccoonDailyGrantStatus(product, credential, fetcher)
    assert.equal(status, null, '完全查不到时必须是 null，不能是「未领」')
  })

  await check('领取路径也翻页：第 74 位已入账 ⇒ already-claimed 且不打触发器', async () => {
    // 刻意让触发器会抛错：如果实现打了它，这个用例就会以异常收场。
    const { fetcher: baseFetcher, calls } = billServer(74)
    let triggerCalls = 0
    const fetcher = async (url, init) => {
      if (String(url).endsWith(RACCOON_DAILY_GRANT_TRIGGER_PATH)) {
        triggerCalls += 1
        throw new Error('已入账时不应调用触发器')
      }
      return baseFetcher(url, init)
    }
    const outcome = await claimRaccoonDailyGrant(product, credential, fetcher)
    assert.equal(outcome.kind, 'already-claimed')
    assert.ok(outcome.message.includes('300'))
    assert.equal(triggerCalls, 0, '账单已确认今日入账 ⇒ 绝不能打触发器')
    assert.ok(calls.length > 1, '领取前的预检也必须翻页（否则就是本次真机缺陷）')
  })

  if (failures > 0) {
    console.error(`\n${failures}/${checks} checks failed`)
    process.exit(1)
  }
  console.log(`\n${checks}/${checks} checks passed`)
} finally {
  hooks.deregister()
}
