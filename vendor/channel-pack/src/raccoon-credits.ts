/**
 * Raccoon Work 积分（余额 + 一次性登录奖励 + 每日积分领取）。
 *
 * ## 三个来源的语义
 *
 * | 来源 | 金额 | 触发方式 | 本模块 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发放 | 不涉及（用户注册即有） |
 * | 桌面端登录奖励 | 3000 | `POST …/login/points/grant` | ✅ `claimRaccoonLoginReward` |
 * | 每日积分发放 | 300 | 客户端调 `GET …/office/v3/setting_info` 触发，按天幂等 | ✅ `claimRaccoonDailyGrant` |
 *
 * ⚠️ **每日积分不是服务端无条件自动发放**：官方桌面端每次启动会调
 * `setting_info`，这就是每日积分的发放触发器。服务端按天幂等，重复调用
 * 不会重复入账；账单里 `points > 0` 且日期为今天的记录是领取成功的权威证据。
 *
 * ⚠️ **登录奖励是幂等一次性的**（已领过返回 `granted:false`），
 * 语义与 Loomy 的新手任务同构，故登记为 `onboardingTasks` 而**不是**
 * `dailyCheckin` —— 后者会让用户以为每天都真的加了额度。
 *
 * ## 只读优先
 *
 * 余额查询用 `GET /points/v1/balance`（**只读**）。在「打开面板」这类
 * 高频路径上**绝不**触碰写端点（Loomy 的 `first-login` 就踩过这个坑：
 * 打开面板即意外触发签到）。
 */

import {
  RACCOON_POINTS_PREFIX,
  RACCOON_DESKTOP_PREFIX,
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonHeaders,
  type RaccoonCredential,
} from './raccoon.js'
import { RACCOON, type RaccoonProduct } from './raccoon-product.js'
import { utc8DayKey } from './credit-usage-ledger.js'
import type { CheckinStatus, ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'

/** 登录奖励的默认额度（服务端未在 popup 里给出时兜底）。 */
export const RACCOON_LOGIN_REWARD_POINTS = 3000

/** 登录奖励在账单里的 `event_name`（用于判定是否已领）。 */
export const RACCOON_LOGIN_REWARD_EVENT_NAME = '桌面端登录奖励'

/** 每日积分发放触发器端点（官方桌面端启动时调用）。 */
export const RACCOON_DAILY_GRANT_TRIGGER_PATH = '/api/web/office/v3/setting_info'

/**
 * 账单核对每页拉取条数。
 *
 * ## ⚠️ 为什么从 20 改到 100（真实缺陷，2026-10-19 真机抓到）
 *
 * 旧实现只拉第一页 20 条。而账单是**按时间倒序**的消耗流水：早上 08:00
 * `setting_info` 刚触发时 +300 是第 1 条，在窗口内；用户用了一上午之后，
 * 那笔「每日积分发放」会被几十条消耗账单挤到第 43 / 74 位 —— **掉出第一页**
 * ⇒ 状态误判成「今日未领」，而钱明明在账上。
 *
 * 真机证据（Chief 用真实凭据查的）：0899 的 +300 在第 74 位、5173 的
 * 在第 43 位，而窗口只有 20 条。
 */
export const RACCOON_DAILY_GRANT_BILL_LIMIT = 100

/**
 * 最多翻几页（`100 × 3 = 300` 条）。
 *
 * 上限的理由是**延迟**：该接口实测约 9 秒/次，无限翻页会把「打开面板」
 * 变成一次几分钟的等待。300 条对「一天的有效流水」足够（实测两个号
 * 74 / 43 位），超出则按「未找到」如实处理，不臆造。
 */
export const RACCOON_DAILY_GRANT_MAX_PAGES = 3

/** 账单核对接口独立超时（毫秒）；该接口实测很慢，需要比默认超时更宽容。 */
export const RACCOON_DAILY_GRANT_BILL_TIMEOUT_MS = 25_000

/** 每日积分在账单里的 `biz_type`。 */
export const RACCOON_DAILY_GRANT_BIZ_TYPE = 'daily_grant'

/** 业务响应信封。 */
interface Envelope {
  ok: boolean
  code: number
  message: string
  data: Record<string, unknown> | undefined
}

/** 解析信封；`code === 0` 为成功。 */
function parseEnvelope(payload: unknown, status: number): Envelope {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const code = typeof record.code === 'number' ? record.code : (status >= 400 ? status : 0)
  const message = typeof record.message === 'string' && record.message.length > 0
    ? record.message
    : (typeof record.details === 'string' ? record.details : '')
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined
  return { ok: code === 0, code, message, data }
}

/** 读成有限数字；非法返回 undefined（**不编造 0**）。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 发一次业务请求并拆信封。
 *
 * ⚠️ 不抛错 —— 调用方按 `ok` 分支处理。积分查询/领取属「尽力而为」，
 * 批量操作时单个账号失败不应中断其余账号。
 */
async function requestJson(
  url: string,
  credential: RaccoonCredential,
  product: RaccoonProduct,
  init: { method: string; body?: string },
  fetcher: typeof fetch,
  timeoutMs: number = RACCOON_REQUEST_TIMEOUT_MS,
): Promise<Envelope> {
  try {
    const response = await fetcher(url, {
      method: init.method,
      headers: raccoonHeaders(credential, {
        platform: product.clientPlatform,
        version: product.clientVersion,
      }),
      ...init.body === undefined ? {} : { body: init.body },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const parsed: unknown = await response.json()
    return parseEnvelope(parsed, response.status)
  } catch (error) {
    return {
      ok: false,
      code: -1,
      message: error instanceof Error ? error.message : String(error),
      data: undefined,
    }
  }
}

/** 构造一个资源包条目。 */
function makePackage(name: string, remaining: number): CreditPackage {
  return {
    name,
    unit: '积分',
    remaining,
    total: remaining,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }
}

/**
 * 查询积分余额（映射成既有的 `CreditBalance` 形状）。
 *
 * ⚠️ 各池**分开作 package**，让用户看出「注册礼包 / 每日 / 充值」是独立来源
 * —— 它们的有效期与回补规则都不同（每日积分每日刷新、充值积分长期有效）。
 *
 * @returns 查不到时返回 `null`（卡片显示原因，**不是** 0）。
 */
export async function fetchRaccoonCreditBalance(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_PREFIX}/balance`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok || envelope.data === undefined) return null

  const available = readNumber(envelope.data.available_points)
  // `available_points` 是核心字段：没有它就说明响应形状不对，不编造数字。
  if (available === undefined) return null

  const packages: CreditPackage[] = []
  const reward = readNumber(envelope.data.reward_points)
  const daily = readNumber(envelope.data.daily_points)
  const topup = readNumber(envelope.data.topup_points)
  const monthly = readNumber(envelope.data.monthly_points)
  if (reward !== undefined) packages.push(makePackage('奖励积分', reward))
  if (daily !== undefined) packages.push(makePackage('每日积分', daily))
  if (monthly !== undefined && monthly > 0) packages.push(makePackage('会员积分', monthly))
  if (topup !== undefined) packages.push(makePackage('充值积分', topup))

  return {
    total: available,
    // 极端情形（服务端只给 total 不给分项）也要有至少一个包，否则 UI 空列表
    packages: packages.length > 0 ? packages : [makePackage('可用积分', available)],
    expiredTotal: 0,
  }
}

/**
 * 领取「桌面端登录奖励」（一次性，幂等）。
 *
 * ⚠️ **不是每日签到**：实测该端点是幂等一次性的（已领过返回 `granted:false`
 * 且账单里能看到上一次的记录）。映射到 `onboardingTasks` 能力。
 *
 * ⚠️ 需要 `X-Client-Platform` 头（值见 `product.clientPlatform`）——
 * 它标识「来自桌面端」，缺了会被拒。见 `raccoonHeaders`。
 *
 * 本函数**不抛错**（失败也返回 `failed`），保证批量领取不会因单个账号中断。
 */
export async function claimRaccoonLoginReward(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_DESKTOP_PREFIX}/login/points/grant`,
    credential,
    product,
    { method: 'POST' },
    fetcher,
  )

  if (!envelope.ok) {
    return {
      kind: 'failed',
      code: envelope.code,
      message: envelope.message.length > 0 ? envelope.message : '领取登录奖励失败',
    }
  }

  // ⚠️ 幂等判据是 `granted`（重复领取同样返回 HTTP 200 + `granted:false`），
  // 故映射成 `already-claimed` 而**不是** `claimed` ——
  // 后者会让用户以为每天都真的加了额度。
  if (envelope.data?.granted !== true) {
    return {
      kind: 'already-claimed',
      message: '该账号已领取过桌面端登录奖励（每号一次）',
    }
  }

  const popup = typeof envelope.data.popup === 'object' && envelope.data.popup !== null
    ? envelope.data.popup as Record<string, unknown>
    : undefined
  const points = readNumber(popup?.points) ?? RACCOON_LOGIN_REWARD_POINTS
  return { kind: 'claimed', credit: points, streakDays: 0, isStreakDay: false }
}

/**
 * 查询「桌面端登录奖励」是否已领（供 `onboarding.status` 用）。
 *
 * 判据：`GET /points/v1/bills` 里是否已有
 * `biz_type === 'reward_grant'` 且 `event_name === '桌面端登录奖励'` 的记录。
 *
 * ⚠️ **不能靠 `balance` 推断** —— 余额是多个来源（注册礼包/每日/充值）的
 * 合计，无法区分某一项是否已领。
 * ⚠️ **不能只按 `biz_type === 'reward_grant'` 判定** —— 「新人注册礼包」
 * 也是 `reward_grant`，把它算作登录奖励会让新用户一开始就显示「已领取」。
 * ⚠️ **服务端没有单独的奖励状态端点**（实测），故只能查账单明细。
 * ⚠️ 查询失败时保守返回 `claimed: false` —— 宁可让用户多点一次
 * （服务端幂等，无害），也不要误报「已领」而让他真的错过。
 */
export async function fetchRaccoonOnboardingStatus(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<{ claimed: boolean; points: number }> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_PREFIX}/bills?paging.limit=50&paging.offset=0`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok || envelope.data === undefined) {
    return { claimed: false, points: RACCOON_LOGIN_REWARD_POINTS }
  }

  const items = Array.isArray(envelope.data.items) ? envelope.data.items : []
  let claimed = false
  let points = RACCOON_LOGIN_REWARD_POINTS
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    if (item.biz_type !== 'reward_grant') continue
    if (item.event_name !== RACCOON_LOGIN_REWARD_EVENT_NAME) continue
    claimed = true
    const billPoints = readNumber(item.points)
    if (billPoints !== undefined && billPoints > 0) points = billPoints
    break
  }
  return { claimed, points }
}

/** 一条账单记录中今日入账的摘要（`claimRaccoonDailyGrant` 内部用）。 */
interface DailyGrantEntry {
  /** 账单名。 */
  name: string
  /** 入账积分。 */
  points: number
  /** 入账时间（HH:MM:SS）。 */
  at: string
}

/** 账单核对结果。 */
interface TodayGrantCheck {
  /** 今日入账积分合计；为 0 表示今日尚无入账。 */
  granted: number
  /** 今日入账条目明细。 */
  entries: DailyGrantEntry[]
  /** 实际翻了几页（诊断用：翻满上限仍未找到时，日志里要能看到这一点）。 */
  pages: number
}

/**
 * 把上游账单的 `created_at` 归一成 **UTC+8 日键**。
 *
 * ## 为什么不能用 `createdAt.slice(0, 10) !== today`（真实缺陷，2026-10-19）
 *
 * 旧实现直接取字符串前 10 个字符与 UTC+8 的「今天」比较，只在
 * **字符串本身就写着 UTC+8 日期**时才成立。上游若用 UTC 表达：
 *
 * | 上游写法 | 真实时刻（UTC+8） | `slice(0,10)` | 正确日键 |
 * |---|---|---|---|
 * | `2026-10-19T00:16:24+08:00` | 10-19 00:16 | 2026-10-19 ✓ | 2026-10-19 |
 * | `2026-10-18T16:16:24Z` | **10-19 00:16** | 2026-10-18 ✗ | 2026-10-19 |
 *
 * 即：**只要上游用 UTC 表达 `created_at`，凌晨 00:00–08:00（UTC+8）之间的入账
 * 就会被判成「昨天」** ⇒ 该账号当天的「今日已领」状态整天显示不出来，而账单里
 * 明明有 +300。这与用户报障的形态一致：两个账号一个显示、一个不显示，
 * 取决于各自入账时刻落在 UTC 的哪一天。
 *
 * 修法：**解析成时间戳再换算 UTC+8**，与账本 `utc8DayKey` 同一纪律（算术换算，
 * 不依赖本机时区）。解析失败（空串 / 非 ISO）返回 `undefined`，调用方跳过
 * —— 不猜、不编造日期。
 */
export function billDayKey(createdAt: string): string | undefined {
  if (createdAt.length === 0) return undefined
  const parsed = Date.parse(createdAt)
  if (!Number.isFinite(parsed)) return undefined
  return utc8DayKey(parsed)
}

/**
 * 核对账单里今天是否有 `points > 0` 的入账（**分页**，见 limit 常量处的缺陷说明）。
 *
 * ## 终止条件（四条，任一成立就停）
 *
 * 1. **某页返回不足 limit** ⇒ 已经到列表末尾；
 * 2. **某页最旧一条的日键早于今天** ⇒ 列表按时间倒序，再往后只会更旧
 *    （⚠️ 只在「该条时间可解析」时才用这条 —— 解析不出来的条目不能当终止依据，
 *    否则一条脏数据就能让整轮提前退出）；
 * 3. **翻到 {@link RACCOON_DAILY_GRANT_MAX_PAGES}** ⇒ 防止慢接口把等待拉爆；
 * 4. 账号今天的入账**已经找到** ⇒ 仍会继续翻到本轮结束吗？不会：
 *    「已找到」只是记录，不直接 break —— 同一天可能有多笔入账（例如补发），
 *    少翻一页会把合计算少。真正的提前退出由条件 2/3 保证。
 *
 * ## ⚠️ **不能**用 `paging.total` 判断是否到头
 *
 * 实测该字段恒为 0（上游说谎）。靠它做终止条件会让翻页在第一页就停下，
 * 这正是本缺陷的一半成因（另一半是 limit 太小）。
 *
 * @returns 账单接口成功且响应可解析时返回 `{ granted, entries, pages }`；
 *   账单接口失败或响应形状不对时返回 `null`（调用方据此判定「无法确认」）。
 */
async function checkTodayGrantBills(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch,
  /** 诊断出口（可选）。翻满上限仍未找到今日入账时记一页数，便于线上排障。 */
  warn?: (message: string) => void,
): Promise<TodayGrantCheck | null> {
  const today = utc8DayKey(Date.now())
  const entries: DailyGrantEntry[] = []
  let granted = 0
  let pages = 0
  /** 本次是否**至少有一页**成功解析（全失败要返回 null，不能当成「未领」）。 */
  let sawAnyPage = false

  for (let page = 0; page < RACCOON_DAILY_GRANT_MAX_PAGES; page += 1) {
    const offset = page * RACCOON_DAILY_GRANT_BILL_LIMIT
    const url = `${product.apiBase}${RACCOON_POINTS_PREFIX}/bills`
      + `?paging.limit=${RACCOON_DAILY_GRANT_BILL_LIMIT}&paging.offset=${offset}`
    const envelope = await requestJson(url, credential, product, { method: 'GET' }, fetcher, RACCOON_DAILY_GRANT_BILL_TIMEOUT_MS)
    if (!envelope.ok || envelope.data === undefined) {
      // 第一页就失败 ⇒ 完全无法确认（返回 null）；后续页失败 ⇒ 用已拿到的部分
      // 如实作答，但**不能**因此说「今天没入账」——已找到的入账照样返回。
      if (!sawAnyPage) return null
      break
    }
    sawAnyPage = true
    pages += 1
    const items = Array.isArray(envelope.data.items) ? envelope.data.items : []
    if (items.length === 0) break

    /** 本页最旧的**可解析**日键（用于「列表已翻过今天」的提前退出）。 */
    let oldestDay: string | undefined
    for (const raw of items) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
      const item = raw as Record<string, unknown>
      const createdAt = typeof item.created_at === 'string' ? item.created_at : ''
      const day = billDayKey(createdAt)
      // 记录本页最旧的可解析日键（列表倒序 ⇒ 最后一条最旧）。
      if (day !== undefined && (oldestDay === undefined || day < oldestDay)) oldestDay = day
      if (day !== today) continue
      const points = readNumber(item.points)
      if (points === undefined || points <= 0) continue
      const name = typeof item.event_name === 'string' && item.event_name.length > 0
        ? item.event_name
        : '积分发放'
      const at = createdAt.replace('T', ' ').slice(11, 19)
      entries.push({ name, points, at })
      granted += points
    }

    // 条件 1：不满一页 ⇒ 到底了。
    if (items.length < RACCOON_DAILY_GRANT_BILL_LIMIT) break
    // 条件 2：本页最旧一条已早于今天 ⇒ 后面的只会更旧，不必再翻。
    // ⚠️ 只在该页**有可解析时间**时才用这条判据（见函数头注释）。
    if (oldestDay !== undefined && oldestDay < today) break
  }

  /**
   * 翻满上限仍未找到今日入账 ⇒ 记一行诊断。
   *
   * ⚠️ **这只是日志，不改结论**：仍然如实报「今天没找到入账」（可能是真的没领，
   * 也可能是流水超过 300 条 —— 后者只有日志能让人看出来）。
   */
  if (granted === 0 && pages >= RACCOON_DAILY_GRANT_MAX_PAGES) {
    warn?.(`[channel-pack] raccoon 账单已翻 ${pages} 页（${pages * RACCOON_DAILY_GRANT_BILL_LIMIT} 条）仍未找到今日入账，按「未找到」处理`)
  }
  return { granted, entries, pages }
}

/**
 * 查询 Raccoon 每日积分领取状态（账单口径，供 `credits.status` 用）。
 *
 * 直接读账单：今天已有 `points > 0` 的入账即视为「已领」；否则视为未领。
 * 查询失败时返回 `null`（由 `collectCreditsStatus` 在对应账号上展示为空状态）。
 */
export async function fetchRaccoonDailyGrantStatus(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
  warn?: (message: string) => void,
): Promise<CheckinStatus | null> {
  const result = await checkTodayGrantBills(product, credential, fetcher, warn)
  if (result === null) return null
  const todayCheckedIn = result.granted > 0
  return {
    active: true,
    todayCheckedIn,
    streakDays: 0,
    dailyCredit: 300,
    todayCredit: todayCheckedIn ? result.granted : 0,
    isStreakDay: false,
    totalCredits: 0,
    checkinDates: todayCheckedIn ? [utc8DayKey(Date.now())] : [],
    activityName: '每日积分',
    themeName: '每日积分',
    endTime: '',
  }
}

/**
 * 领取 Raccoon 每日积分。
 *
 * 流程：先查账单——今天已有入账则报 `already-claimed` 且**不再打触发器**；
 * 否则打 `setting_info` 触发器，再查账单核实——有入账报 `claimed`
 *（credit 为今日入账合计），无入账如实报失败（「未能确认今日入账」）。
 *
 * ⚠️ **成功判据是账单里有今日入账，不是 HTTP 200**：`setting_info` 的
 * 响应只含发放通知（`point_grant_popups` / `point_grant_toast`），不表示
 * 积分真的到账；必须以账单核对为准。
 *
 * 返回形状对齐 {@link ClaimOutcome}，`coversToday` 由账单核对结果决定：
 * 今日有入账时（claimed / already-claimed）覆盖今天，否则不覆盖。
 */
export async function claimRaccoonDailyGrant(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  // ① 先查账单：今天已有入账 → 直接 already-claimed，不再打触发器
  const firstCheck = await checkTodayGrantBills(product, credential, fetcher)
  if (firstCheck !== null && firstCheck.granted > 0) {
    return {
      kind: 'already-claimed',
      message: `今日已领取 ${firstCheck.granted} 积分`,
    }
  }

  // ② 打触发器。失败不阻断：继续用账单核对给出最终结论。
  const trigger = await requestJson(
    `${product.apiBase}${RACCOON_DAILY_GRANT_TRIGGER_PATH}`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )

  // ③ 触发后再查账单，作为权威结果。
  const secondCheck = await checkTodayGrantBills(product, credential, fetcher)
  if (secondCheck === null) {
    return {
      kind: 'failed',
      code: -1,
      message: '未能确认今日入账',
    }
  }
  if (secondCheck.granted > 0) {
    return {
      kind: 'claimed',
      credit: secondCheck.granted,
      streakDays: 0,
      isStreakDay: false,
    }
  }

  // ④ 账单核对无入账：如实报失败，不拿 HTTP 200 冒充成功
  if (!trigger.ok) {
    return {
      kind: 'failed',
      code: trigger.code,
      message: `触发器调用失败：${trigger.message}`,
    }
  }
  return {
    kind: 'failed',
    code: 0,
    message: '未能确认今日入账',
  }
}

/** 默认产品配置下的便捷包装（供 `RaccoonAuth` 调用）。 */
export const raccoonCreditsForDefaultProduct = {
  fetchBalance: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    fetchRaccoonCreditBalance(RACCOON, credential, fetcher),
  claimLoginReward: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    claimRaccoonLoginReward(RACCOON, credential, fetcher),
  fetchOnboardingStatus: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    fetchRaccoonOnboardingStatus(RACCOON, credential, fetcher),
  claimDailyGrant: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    claimRaccoonDailyGrant(RACCOON, credential, fetcher),
  fetchDailyGrantStatus: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    fetchRaccoonDailyGrantStatus(RACCOON, credential, fetcher),
}
