/**
 * 发消息路径的**节流余额采样**（八家「只有开面板才记账」渠道的共用修补）。
 *
 * ## 为什么需要这个模块
 *
 * 积分消耗账本（`credit-usage-ledger.ts`）只认「相邻两次余额读数的差值」。
 * 修复前，八家渠道（codearts / lobsterai / qoder / qodercn / trae / cline /
 * minimax / gemini / zcode）的**唯一**采样入口是渠道面板的 `credits.balances`
 *（客户端 90 秒轮询）。面板不开 ⇒ 对话期间一次读数都没有 ⇒ 差值法无从计算，
 * 用户看到的是「少记约 10 倍」甚至完全不记（诊断证据见
 * `docs/verification/2026-10-19-credit-sampling-fix.md`）。
 *
 * 本模块把采样挂到**真正发消息**的路径（各渠道的 `resolveCredential`），
 * 但加了三道闸，确保它绝不拖累主路径：
 *
 * 1. **按账号节流**（默认 60 秒，`DSH_CHANNEL_PACK_CREDIT_SAMPLE_MS` 可覆盖，
 *    `0` 合法表示每次都采）：一次选号最坏多打一次只读余额请求；
 *    ⚠️ 节流键必须是 **provider + accountId** —— 只按 provider 会让多账号
 *    互相饿死（A 采完 60 秒内 B 永远轮不到）。
 * 2. **不阻塞**：`sample()` 立即返回，请求在后台跑；调用方 `void` 掉即可。
 *    主路径的凭据解析不等它 —— 余额是统计信息，不值得让每条消息多等一次网络。
 * 3. **异常全吞**：采样失败只写一行日志，绝不冒泡到发消息路径。
 *
 * ## 与面板/选号路径的关系
 *
 * 三条路径共用同一个 `CreditUsageLedger`，重复采样**无害**：差值法下
 * 「A 采到 300、B 也采到 300」的合并消耗与只采一次完全相同（总量守恒）。
 * 本模块只负责「何时采、采谁」，记账语义仍归账本。
 *
 * @module vendor/channel-pack/src/credit-usage-sampler.ts
 */

import type { CreditBalance } from './credits.js'

/** 默认节流窗口（毫秒）。60 秒取自「一次请求最多 +1 次只读请求」的取舍。 */
export const CREDIT_SAMPLE_TTL_MS = 60_000

/** 节流窗口的环境变量名。 */
export const DSH_CHANNEL_PACK_CREDIT_SAMPLE_MS = 'DSH_CHANNEL_PACK_CREDIT_SAMPLE_MS'

/** 非负毫秒数：非法值（空 / 非数字 / 负数）回落到默认值；`0` 是合法值。 */
function nonNegativeMs(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback
  const parsed = Number(raw.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** 读采样节流窗口（`0` = 不节流，每次都采）。 */
export function creditSampleTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeMs(env[DSH_CHANNEL_PACK_CREDIT_SAMPLE_MS], CREDIT_SAMPLE_TTL_MS)
}

/**
 * 把一份 `CreditBalance` 压成「池名 → 剩余」。
 *
 * 与面板路径（`collectCreditBalances` 的 `onBalanceSample`）**同一口径**：
 * 只取 `active === true` 且剩余为有限数的包 —— 两边口径不同会让同一天
 * 出现「面板记了、选号路径没记」的差值噪声。
 *
 * ## ⚠️ 空 `packages` 的兜底（MiniMax 必需）
 *
 * MiniMax 的余额响应里 `details[]` 会被折叠成一个 `total`，`packages` 恒为空
 * （见 `fetchMinimaxCreditBalance` 的注释）。若严格按「逐包」采样，这家会
 * **永远记不到一笔账**。故当 `packages` 里没有任何可用池时，退到**汇总数**
 * 作为唯一池（池名由调用方给，缺省「积分」）。
 *
 * 兜底只在「一个包都没有」时触发：有包时汇总数会与逐包重复计量，
 * 差值法下会**双倍记账**，绝不能两个都记。
 *
 * @param balance 上游读数
 * @param fallbackPoolName 空 `packages` 时给汇总数用的池名（缺省「积分」）
 * @returns 没有可用数字时返回 `undefined`（调用方跳过本次采样，不记空对象）。
 */
export function creditBalancePools(
  balance: CreditBalance | null | undefined,
  fallbackPoolName = '积分',
): Record<string, number> | undefined {
  if (balance === null || balance === undefined) return undefined
  const pools: Record<string, number> = {}
  for (const pkg of balance.packages) {
    if (pkg.active === true && typeof pkg.remaining === 'number' && Number.isFinite(pkg.remaining)) {
      pools[pkg.name] = pkg.remaining
    }
  }
  if (Object.keys(pools).length === 0 && Number.isFinite(balance.total)) {
    return { [fallbackPoolName]: balance.total }
  }
  return Object.keys(pools).length === 0 ? undefined : pools
}

/** 采样器依赖（全部可替换 ⇒ 单测零网络）。 */
export interface CreditUsageSamplerOptions {
  /** 记账出口（通常是 `CreditUsageLedger.sample`，它内部已吞异常）。 */
  record: (provider: string, accountId: string, balances: Record<string, number>) => void
  /** 节流时钟（注入以便单测）。 */
  now?: () => number
  /** 节流窗口（省略时读环境变量）。 */
  ttlMs?: number
  /** 失败日志出口（默认静默）。 */
  warn?: (message: string) => void
}

/**
 * 按账号节流的余额采样器。
 *
 * 用法（各渠道 `resolveCredential` 里）：
 *
 * ```ts
 * void sampler.sample(TRAE.id, entry.id, async () => {
 *   return creditBalancePools(await fetchTraeCreditBalance(credential, TRAE))
 * })
 * ```
 */
export class CreditUsageSampler {
  private readonly now: () => number
  private readonly ttlMs: number
  /** `provider:accountId` → 上次**尝试**采样的时刻（失败也计入，防失败风暴）。 */
  private readonly lastAttempt = new Map<string, number>()
  /** 正在飞的采样（同一账号并发请求只发一次）。 */
  private readonly inFlight = new Set<string>()

  constructor(private readonly options: CreditUsageSamplerOptions) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? creditSampleTtlMs()
  }

  /**
   * 采一次（尽力而为，永远不抛错）。
   *
   * @param provider provider id
   * @param accountId 账号池条目 id
   * @param read 真正读余额的闭包；返回 `undefined`/`null` 表示「这次没读到」
   *   （失败或该账号没有可用池），不记账也不报错。
   * @returns 本次是否真的发起了采样（节流命中/并发去重时为 false）。
   *   ⚠️ 返回值只给单测与诊断用，业务调用方应 `void` 掉。
   */
  async sample(
    provider: string,
    accountId: string,
    read: () => Promise<Record<string, number> | null | undefined>,
  ): Promise<boolean> {
    if (provider.length === 0 || accountId.length === 0) return false
    const key = `${provider}:${accountId}`
    if (this.inFlight.has(key)) return false
    const previous = this.lastAttempt.get(key)
    const at = this.now()
    if (previous !== undefined && at - previous < this.ttlMs) return false
    this.lastAttempt.set(key, at)
    this.inFlight.add(key)
    try {
      const balances = await read()
      if (balances === null || balances === undefined) return true
      if (Object.keys(balances).length === 0) return true
      this.options.record(provider, accountId, balances)
      return true
    } catch (error) {
      this.warn(`[channel-pack] ${provider} 账号 ${accountId} 余额采样失败（忽略）: ${String(error)}`)
      return true
    } finally {
      this.inFlight.delete(key)
    }
  }

  /** 清空节流记录（测试与「重置统计」用）。 */
  reset(): void {
    this.lastAttempt.clear()
    this.inFlight.clear()
  }

  private warn(message: string): void {
    this.options.warn?.(message)
  }
}
