/**
 * 每日积分消耗账本的**按日聚合**持久化（三期：跨重启保留 + 历史）。
 *
 * ## 形态与取舍（与 `token-ledger-store.ts` 完全同款）
 *
 * - **只落日聚合，不落明细**：明细是进程内的（`CreditUsageLedger.samples`），
 *   持久化要回答的是「上周/这个月用了多少积分」，天然粒度就是**日**。
 * - **独立文档**（`credit-usage.json`），不进 state.json —— 理由与
 *   `permanent-lock-store.ts` 同源：state.json 被另一条工作区的旧代码整体
 *   重写时会静默抹掉它不认识的键。
 * - **节流落盘**（默认 30 秒防抖）：记账在选号路径上，每笔都同步写盘会把
 *   「一次选号」变成「一次磁盘写」。窗口内崩溃最多丢最近 30 秒的计数 ——
 *   对统计型数据是可接受的精度损失；且**上一轮的读数是下次的基线**，
 *   丢的是「差值」而非「余额」，重启后重新建立基线即可自愈。
 * - **增量合并写，不是整体覆盖**（真实缺陷，`token-ledger-store.ts` 审计
 *   发现并原样复现）：两个实例并存时各自内存视图独立，整体覆盖会互相抹掉。
 *
 * ## ⚠️ 已知限制：跨进程并发仍非原子（与 token-ledger-store.ts 同款，未修）
 *
 * `flush()` 是 `readFile → 合并 → writeFile(tmp) → rename`。`rename` 本身
 * 原子，但「读」与「写」之间有窗口。真实规模（单 profile、日桶数受
 * provider × 账号数限制）下影响可忽略。**如实记录**，不宣称已解决。
 *
 * ## 日界与保留
 *
 * UTC+8（与各渠道每日额度结算时区一致），默认保留 {@link CREDIT_USAGE_DAYS}
 * 天，更早的日桶在落盘时淘汰。
 *
 * @module vendor/channel-pack/src/credit-usage-store.ts
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CreditUsageDay } from './credit-usage-ledger.js'
import { resolveChannelPackHome } from './channel-pack-store.js'

/** 独立文档的文件名（与 state.json 等同目录）。 */
export const CREDIT_USAGE_FILE = 'credit-usage.json'

/** 保留天数：更早的日桶在落盘时淘汰。 */
export const CREDIT_USAGE_DAYS = 90

/** 落盘防抖窗口（毫秒）。 */
export const CREDIT_USAGE_FLUSH_DEBOUNCE_MS = 30_000

const SCHEMA = 'dsh-codearts-auth/credit-usage/v1'

/** 文档形态：`{ schema, providers: { <provider>: { days: [...] } } }`。 */
export interface CreditUsageDocument {
  schema: string
  providers: Record<string, { days: CreditUsageDay[] }>
}

/** 空文档（首次运行 / 文档不存在）。 */
export function emptyCreditUsageDocument(): CreditUsageDocument {
  return { schema: SCHEMA, providers: {} }
}

/** 把任意输入归一成合法文档；不匹配时返回空文档（不抛错）。 */
export function sanitizeCreditUsageDocument(raw: unknown): CreditUsageDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyCreditUsageDocument()
  const record = raw as Record<string, unknown>
  const providers = record.providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    return emptyCreditUsageDocument()
  }
  const result: CreditUsageDocument = emptyCreditUsageDocument()
  for (const [provider, value] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || !Array.isArray((value as { days?: unknown }).days)) continue
    const days: CreditUsageDay[] = []
    for (const day of (value as { days: unknown[] }).days) {
      if (day === null || typeof day !== 'object' || Array.isArray(day)) continue
      const row = day as Record<string, unknown>
      if (typeof row.day !== 'string' || row.day.length === 0) continue
      days.push({
        day: row.day,
        spent: Number.isFinite(Number(row.spent)) ? Math.max(0, Math.round(Number(row.spent))) : 0,
        gained: Number.isFinite(Number(row.gained)) ? Math.max(0, Math.round(Number(row.gained))) : 0,
        accounts: Number.isFinite(Number(row.accounts)) ? Math.max(0, Math.round(Number(row.accounts))) : 0,
      })
    }
    if (days.length > 0) result.providers[provider] = { days }
  }
  pruneOldDays(result)
  return result
}

/** 淘汰超过保留天数的日桶（按日键字典序，`YYYY-MM-DD` 可直接比较）。 */
export function pruneOldDays(document: CreditUsageDocument, days = CREDIT_USAGE_DAYS): void {
  for (const entry of Object.values(document.providers)) {
    if (entry.days.length <= days) continue
    entry.days.sort((a, b) => (a.day < b.day ? 1 : -1))
    entry.days.length = Math.min(entry.days.length, days)
  }
}

/**
 * 独立文档的读写（同步读、异步写）。
 *
 * 与 `PermanentLockStore` / `LongTermPreferredStore` 的差别：本接口多一个
 * `flush()`（增量合并写 + 防抖由调用方控制节流），因为记账是高频路径。
 */
export interface CreditUsageStore {
  readonly kind: 'file' | 'memory'
  /** 载入文档；不存在时返回空文档（首次运行）。 */
  load(): CreditUsageDocument
  /** 合并写入（读 → 合并 → 原子 rename）。 */
  save(document: CreditUsageDocument): Promise<void>
}

/** 无持久化后端时的显式降级（与 MemoryLockStore 同策）：功能不报错，只是不跨重启。 */
class MemoryUsageStore implements CreditUsageStore {
  readonly kind = 'memory' as const
  private document: CreditUsageDocument = emptyCreditUsageDocument()

  load(): CreditUsageDocument {
    return JSON.parse(JSON.stringify(this.document)) as CreditUsageDocument
  }

  async save(document: CreditUsageDocument): Promise<void> {
    this.document = JSON.parse(JSON.stringify(document)) as CreditUsageDocument
  }
}

class FileUsageStore implements CreditUsageStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): CreditUsageDocument {
    try {
      if (!existsSync(this.path)) return emptyCreditUsageDocument()
      return sanitizeCreditUsageDocument(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch (error) {
      // 损坏时按空文档处理：统计型数据「从零开始」比「加载失败」好 —— 后者
      // 会让整个积分看板不可用。注意这与 permanent-lock 的方向不同（那份
      // 丢了会误烧积分），此处丢的只是历史统计。
      this.logger?.warn(`[channel-pack] 读取 ${this.path} 失败，按空账本处理: ${String(error)}`)
      return emptyCreditUsageDocument()
    }
  }

  async save(document: CreditUsageDocument): Promise<void> {
    pruneOldDays(document)
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(document, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

/**
 * 创建账本存储后端。
 *
 * home 的解析与账号池**同一个函数**（`resolveChannelPackHome`），保证所有
 * channel-pack 状态文档永远落在同一目录。
 */
export function createCreditUsageStore(ctx: Context): CreditUsageStore {
  const home = resolveChannelPackHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[channel-pack] 无法定位 DSH home，积分消耗记录仅存在于内存中')
    return new MemoryUsageStore()
  }
  return new FileUsageStore(join(home, 'channel-pack', CREDIT_USAGE_FILE), ctx.logger)
}
