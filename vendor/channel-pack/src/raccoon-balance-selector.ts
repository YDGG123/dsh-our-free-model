/**
 * Raccoon 账号余额缓存 + 按余额优先的选号（与 `loomy-balance-selector.ts` 同型）。
 *
 * ## 它解决什么
 *
 * Raccoon 的账号选择原本只有「手动顺序 + 限流排除」（`getAvailableAccount`），
 * **不看余额**：每日积分（服务端按日自动发放，每天 300）耗尽后服务端继续扣
 * 长期积分（奖励 / 会员 / 充值）且不报错 —— 于是手动顺序第一位的号会一直
 * 烧长期积分，第二个号的每日额度原封不动地浪费（与 Loomy 修过的同型缺陷）。
 *
 * 本模块在**选号之前**查各账号余额并分档，把消耗平摊到「还有每日积分」的
 * 号上；两个号的每日积分都用尽之后，才落到长期积分。
 *
 * ## 分档（数字越小越优先）
 *
 * | 档位 | 判据 | 含义 |
 * |---|---|---|
 * | 0 | 「每日积分」包 remaining > 0 | 有今日额度（每天刷新、不用会浪费） |
 * | 1 | available_points > 0 | 只剩长期积分（奖励 / 会员 / 充值） |
 * | 2 | 其余（含**查询失败**） | 无可用余额 |
 *
 * ⚠️ **档内保持传入顺序**（= 用户在面板里拖拽的手动顺序），不重排 —— 与
 * `getAvailableAccount` / loomy-balance-rank 的既有语义一致（唯一例外：
 * `longTermOrder: 'descending'` 只重排长期档，见 `RaccoonRankOptions`）。
 *
 * ⚠️ **锁定长期积分时（`locked: true`）只返回每日档**（档 0）：档 1 与档 2
 * 的账号直接剔除、不参与选号 —— 留在队尾也会被调用方按顺序取到，锁定就
 * 形同虚设。语义详见 `RaccoonRankOptions.locked` 的说明。
 *
 * ⚠️ **查询失败归入最后一档**（与 Loomy 同约定）：宁可把请求发给能确认
 * 余额的号，也不把一次网络抖动当成"额度用尽"。
 *
 * ⚠️ 本模块是**纯选号**（排序 + 缓存），凭据解析与账本回报由调用方
 * （`src/index.ts` 的 raccoon 接线）完成。
 *
 * ## 缓存（与 Loomy 同款 TTL）
 *
 * 成功 60 秒 / 失败 5 秒：同一轮对话几乎不重复查；一次抖动不会伪装成
 * "额度用尽"整整一分钟。调用方在**选中某号后**可 `invalidate(id)` 该号，
 * 让下一次选号立刻重查 —— 每日→长期的边界因此只漏一个请求的量
 * （服务端按请求扣费，客户端无法原子地感知边界）。
 */

import type { RaccoonCredential } from './raccoon.js'
import type { RaccoonProduct } from './raccoon-product.js'
import { fetchRaccoonCreditBalance } from './raccoon-credits.js'

/** 成功余额的缓存 TTL（毫秒）。 */
export const RACCOON_BALANCE_CACHE_TTL_MS = 60_000

/** 失败余额的缓存 TTL（毫秒）—— 比 success 短一个数量级（与 Loomy 同款）。 */
export const RACCOON_BALANCE_ERROR_CACHE_TTL_MS = 5_000

/** `raccoon-credits` 里「每日积分」包的展示名（`makePackage('每日积分', …)`）。 */
const RACCOON_DAILY_PACKAGE_NAME = '每日积分'

/** 一条待选账号（调用方从账号池取出）。 */
export interface RaccoonCandidateAccount {
  id: string
  credentialRef: string
}

/** 单个账号的余额（含查询失败标记）。 */
export interface RaccoonAccountBalanceEntry {
  id: string
  /** 查询是否成功；false 时两个余额字段均为 undefined。 */
  ok: boolean
  /** 查询失败原因（诊断用）。 */
  error?: string
  /** 「每日积分」包的剩余；查询失败时 undefined。 */
  dailyBalance?: number
  /** available_points（全部池之和）；查询失败时 undefined。 */
  totalBalance?: number
}

/**
 * 锁定状态下「无可用账号」的原因。
 *
 * ⚠️ 两者**必须分开报**（与 Loomy 的 2026-09-29 报障同型教训）：混成一句
 * 「每日积分都已用尽」，用户就会去解锁、白等到明天 —— 而实际原因可能只是
 * 一次网络抖动，号其实还有每日额度。
 */
export type RaccoonNoAccountReason =
  /** 所有候选都查到了余额，且每日积分确实都是 0。 */
  | { kind: 'exhausted' }
  /** 至少一个候选**查询失败**，无法判定它是否还有每日积分。 */
  | { kind: 'unknown'; errors: string[] }

/** 选号结果：选中，或「为什么没选中」。 */
export type RaccoonSelectionResult
  = { ok: true; account: RaccoonCandidateAccount; balance: RaccoonAccountBalanceEntry }
  | { ok: false; reason: RaccoonNoAccountReason }

/** 选号依赖（便于单测注入）。 */
export interface RaccoonSelectionDeps {
  product: RaccoonProduct
  /** 解析某账号的凭据；返回 undefined 表示不可用。 */
  resolveCredential: (credentialRef: string) => Promise<RaccoonCredential | undefined>
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 当前时间（测试用）。 */
  now?: () => number
  /** 成功 TTL 覆盖（测试用）。 */
  ttlMs?: number
  /** 失败 TTL 覆盖（测试用）。 */
  errorTtlMs?: number
}

/** 一个账号的缓存条目。 */
interface CacheEntry {
  at: number
  value: RaccoonAccountBalanceEntry
}

/**
 * 排序选项。
 *
 * ## `locked`（锁定长期积分）
 *
 * 与 Loomy / 两个 buddy 的「锁定永久积分」同一语义：锁定后**长期积分
 * 不参与选号** —— 只剩长期积分的账号在锁定期间等同于不可用（而不是
 * 降到长期档）。每日积分照常可用。
 *
 * ## `longTermOrder`（长期档内的排序）
 *
 * 两个号的每日积分都用尽、落到长期档之后，**先烧哪个号的长期积分**：
 *
 * - `'manual'`（默认）：保持手动拖拽顺序 —— 与既有语义一致，排第一的号
 *   先烧，烧到 0 再换下一个（用户可把「长期积分多」或「快到期」的号拖到
 *   后面来保护它）。
 * - `'descending'`：按长期余额从多到少 —— 先烧**余额多**的号。适合
 *   「把小号的长期积分清掉、保住大号」的场景。
 *
 * ⚠️ 只影响**长期档**内部的顺序；每日档内永远是手动顺序（有每日额度时
 * 谁先谁后由拖拽决定，与余额多少无关 —— 每日额度人人一样多，按余额排
 * 没有意义）。查询失败的号永远排最后。
 *
 * ## `longTermFirst`（长期档的优先账号，用户手动指定）
 *
 * 每日额度用尽后，先烧**指定账号**的长期积分，其余账号按 `longTermOrder`
 * （默认手动顺序）排列 —— 优先级高于 `longTermOrder`。只改档 1 内部顺序：
 * 该号还有每日积分时照走每日档（用户指定的是「烧长期的顺序」，不是
 * 「优先使用这个号」）；id 不在候选里（已删/停用）则自然失效，安全回退。
 */
export interface RaccoonRankOptions {
  /** 是否锁定长期积分（锁定时只剩长期积分的账号不可用）。 */
  locked?: boolean
  /** 长期档内的排序：手动顺序（默认）或按长期余额降序。低于 {@link longTermFirst}。 */
  longTermOrder?: 'manual' | 'descending'
  /** 长期积分优先账号 id：排在长期档最前；不影响档位判定与每日档。 */
  longTermFirst?: string
}
export class RaccoonBalanceSelector {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: RaccoonSelectionDeps) {}

  /** 清空缓存（手动刷新余额后可调用）。 */
  invalidate(accountId?: string): void {
    if (accountId === undefined) this.cache.clear()
    else this.cache.delete(accountId)
  }

  /**
   * 查一个账号的余额（带 TTL 缓存；失败条目 5 秒后过期，成功 60 秒）。
   */
  async balanceOf(account: RaccoonCandidateAccount): Promise<RaccoonAccountBalanceEntry> {
    const now = this.deps.now?.() ?? Date.now()
    const cached = this.cache.get(account.id)
    if (cached !== undefined) {
      const ttl = cached.value.ok
        ? (this.deps.ttlMs ?? RACCOON_BALANCE_CACHE_TTL_MS)
        : (this.deps.errorTtlMs ?? RACCOON_BALANCE_ERROR_CACHE_TTL_MS)
      if (now - cached.at < ttl) return cached.value
    }

    const value = await this.fetchBalance(account)
    this.cache.set(account.id, { at: now, value })
    return value
  }

  /** 真正发请求查一次余额（只读 `GET /points/v1/balance`）。 */
  private async fetchBalance(account: RaccoonCandidateAccount): Promise<RaccoonAccountBalanceEntry> {
    let credential: RaccoonCredential | undefined
    try {
      credential = await this.deps.resolveCredential(account.credentialRef)
    } catch (error) {
      return {
        id: account.id,
        ok: false,
        error: `读取凭据失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (credential === undefined) {
      return { id: account.id, ok: false, error: '凭据未配置或已失效' }
    }

    const detail = await fetchRaccoonCreditBalance(
      this.deps.product,
      credential,
      this.deps.fetcher ?? fetch,
    )
    if (detail === null) {
      return { id: account.id, ok: false, error: '余额查询失败（凭据失效或响应异常）' }
    }
    const daily = detail.packages.find(p => p.name === RACCOON_DAILY_PACKAGE_NAME)?.remaining
    return {
      id: account.id,
      ok: true,
      dailyBalance: daily,
      totalBalance: detail.total,
    }
  }

  /**
   * 按余额分档排序候选账号（**稳定排序**：档内保持传入顺序）。
   *
   * 查询失败的号归最后一档 —— 排序只保证「有余额的在前」，**不保证第一个
   * 一定可用**：全部查不到时返回的仍是传入顺序（与 Loomy 解锁态的既有
   * 行为一致 —— 让上游去报余额不足，错误信息更准确）。
   *
   * ⚠️ **锁定时（`locked: true`）只返回每日档**：只剩长期积分与无余额/查不到
   * 的账号**不参与选号**（直接从结果中剔除，而不是排在后面 —— 调用方按顺序
   * 取用，留在队尾就会被取到，锁定形同虚设）。全部剔除后返回空数组，由
   * {@link select} 补上「为什么没有」。
   *
   * @param candidates - 已按 `enabled` 与模型限流过滤过的候选（顺序即手动优先级）。
   * @param options - 见 {@link RaccoonRankOptions}。
   * @returns 排序后的**新数组**（不修改入参）。
   */
  async rank(
    candidates: readonly RaccoonCandidateAccount[],
    options: RaccoonRankOptions = {},
  ): Promise<RaccoonCandidateAccount[]> {
    if (candidates.length === 0) return []
    const balances = await Promise.all(candidates.map(c => this.balanceOf(c)))
    const tierOf = (entry: RaccoonAccountBalanceEntry): number => {
      if (positiveNumber(entry.dailyBalance) > 0) return 0
      if (positiveNumber(entry.totalBalance) > 0) return 1
      return 2
    }
    const locked = options.locked === true
    const descending = options.longTermOrder === 'descending'
    // 用户手动指定的优先账号（见 RaccoonRankOptions.longTermFirst）：
    // 只在长期档内生效 —— 比较器只在双方都处于档 1 时给出倾向。
    const first = typeof options.longTermFirst === 'string' ? options.longTermFirst : undefined
    return candidates
      .map((account, index) => ({
        account,
        index,
        tier: tierOf(balances[index]!),
        total: positiveNumber(balances[index]!.totalBalance),
      }))
      // 锁定：只留每日档（见上）。查询失败的号也因此被剔除 —— 它的每日余额
      // 无法确认，选中它可能照样烧长期积分（与 Loomy 锁定态同判）。
      .filter(row => !locked || row.tier === 0)
      .sort((a, b) => (a.tier - b.tier)
        // 长期档 + 指定优先账号：该账号排在档 1 最前（优先于 descending ——
        // 显式的用户意图强于任何自动排序）。不在候选里则两个比较项都不命中，
        // 自然回退。
        || (a.tier === 1 && first !== undefined
          ? (a.account.id === first ? -1 : b.account.id === first ? 1 : 0)
          : 0)
        // 长期档 + descending：按长期余额从多到少；并列回退手动顺序。
        || (a.tier === 1 && descending ? b.total - a.total : 0)
        || (a.index - b.index))
      .map(row => row.account)
  }

  /**
   * 从候选中按余额优先选**一个**账号（`pickRaccoonAccount` 的选号入口）。
   *
   * 与 {@link rank} 的分工：`rank` 只管排序；本方法把「排序后第一个」补全成
   * 带余额条目的选中结果，并在**锁定且无每日档可用**时给出可读的原因
   * （`exhausted` = 真的用尽 / `unknown` = 有号查不到，见
   * {@link RaccoonNoAccountReason}）。
   *
   * ⚠️ **解锁态的既有行为**：所有号余额为 0 也返回第一个候选 —— 让上游去报
   * 余额不足（错误信息更准确），**不**在客户端抢先编一句「用尽了」。
   *
   * ⚠️ 排序只保证「有余额的在前」，**不保证第一个一定可用**（凭据解析在
   * 调用方 `pickRaccoonAccount` 里做，查不到会换下一个候选）。
   */
  async select(
    candidates: readonly RaccoonCandidateAccount[],
    options: RaccoonRankOptions = {},
  ): Promise<RaccoonSelectionResult> {
    if (candidates.length === 0) {
      return { ok: false, reason: { kind: 'exhausted' } }
    }
    // 先并发取余额（写入缓存），rank 内部对同一批账号走缓存，不再发请求。
    const balances = await Promise.all(candidates.map(c => this.balanceOf(c)))
    const ranked = await this.rank(candidates, options)
    const first = ranked[0]
    if (first === undefined) {
      // 空结果只会在锁定时出现（见 rank 的剔除语义）。
      return { ok: false, reason: this.noAccountReason(balances) }
    }
    const balance = balances.find(entry => entry.id === first.id)
    if (balance === undefined) {
      return { ok: false, reason: this.noAccountReason(balances) }
    }
    return { ok: true, account: first, balance }
  }

  /**
   * 判定「为什么没有可用账号」：区分**真的用尽**与**查不到**。
   *
   * 只要有任何一个候选查询失败，就不能断言"每日积分都用尽了" —— 我们对它的
   * 余额其实一无所知（与 Loomy / buddy 的 `noAccountReason` 同约定）。
   */
  private noAccountReason(balances: readonly RaccoonAccountBalanceEntry[]): RaccoonNoAccountReason {
    const errors = balances.filter(b => !b.ok).map(b => b.error ?? '未知原因')
    return errors.length > 0 ? { kind: 'unknown', errors } : { kind: 'exhausted' }
  }
}

/** 把余额归一化为安全非负数；非法值（NaN / 负数 / undefined）归 0。 */
function positiveNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}
