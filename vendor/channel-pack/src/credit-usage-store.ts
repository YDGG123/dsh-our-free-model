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
 *   本文件的做法与 `token-ledger-store.ts` 同源：保存时**重读盘上当前内容**，
 *   只把「相对上次落盘基线 `written` 的增量」累加上去（见 `save()` 的算法注释）。
 *
 * ## ⚠️ 已知限制：跨进程并发仍非原子（与 token-ledger-store.ts 同款，未修）
 *
 * `save()` 是 `readFile → 合并 → writeFile(tmp) → rename`。`rename` 本身
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
import { accountCountOf, mergeAccountIds, type CreditUsageDay, type CreditUsageDaysDocument } from './credit-usage-ledger.js'
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
      /**
       * 账号 id 集合（并集语义，见 `CreditUsageDay.accountIds`）。
       *
       * ⚠️ 必须**保留**：清洗只做钳制，不能丢字段 —— 丢掉集合就退回「只有
       * 计数」的老形态，跨 flush 窗口的计数缺陷会立刻复现。
       * 逐项校验（非字符串 / 空串 / 重复一律剔除），上限与明细表同一量级。
       */
      const accountIds = Array.isArray(row.accountIds)
        ? [...new Set(row.accountIds
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
            .slice(0, 512))]
        : undefined
      days.push({
        day: row.day,
        spent: Number.isFinite(Number(row.spent)) ? Math.max(0, Math.round(Number(row.spent))) : 0,
        gained: Number.isFinite(Number(row.gained)) ? Math.max(0, Math.round(Number(row.gained))) : 0,
        accounts: accountCountOf({
          accounts: Number.isFinite(Number(row.accounts)) ? Math.max(0, Math.round(Number(row.accounts))) : 0,
          accountIds,
        }),
        ...accountIds !== undefined && accountIds.length > 0 ? { accountIds } : {},
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
 * `save()`（**增量合并写** + 防抖由调用方控制节流），因为记账是高频路径。
 *
 * ## ⚠️ `save()` 的入参是**增量**，不是全量文档
 *
 * 调用方（`CreditUsageLedger.flush`）传的是「自上次成功落盘以来新记的日桶」。
 * 之所以不是全量：全量语义要求两端对「盘上现况」有同一份视图，而两个实例
 * 并存时那份视图必然分叉 —— 谁后写谁抹掉对方（这正是审计发现的真实缺陷）。
 * 增量语义下每个实例只贡献自己新产生的部分，盘上内容由 `save()` 读改写合并。
 *
 * 返回值是**合并后的完整文档**（盘上真实内容）：调用方据此更新自己的历史视图，
 * 否则「重启前那段」在面板里会一直缺着。
 */
export interface CreditUsageStore {
  readonly kind: 'file' | 'memory'
  /** 载入文档；不存在时返回空文档（首次运行）。 */
  load(): CreditUsageDocument
  /** 把 `delta` 的**增量**合并进盘上现况（读 → 合并 → 原子 rename），返回合并结果。 */
  save(delta: CreditUsageDaysDocument): Promise<CreditUsageDocument>
}

/** 无持久化后端时的显式降级（与 MemoryLockStore 同策）：功能不报错，只是不跨重启。 */
class MemoryUsageStore implements CreditUsageStore {
  readonly kind = 'memory' as const
  private document: CreditUsageDocument = emptyCreditUsageDocument()

  load(): CreditUsageDocument {
    return cloneDocument(this.document)
  }

  async save(delta: CreditUsageDaysDocument): Promise<CreditUsageDocument> {
    this.document = mergeDocument(this.document, delta)
    return cloneDocument(this.document)
  }
}

class FileUsageStore implements CreditUsageStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): CreditUsageDocument {
    return this.readFile()
  }

  private readFile(): CreditUsageDocument {
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

  /**
   * **增量合并写**。
   *
   * 与 `token-ledger-store.ts` 的 `flush()` 同源：先重读盘上**当前**内容
   *（别的实例可能刚写过），再把本次增量累加上去，最后原子 rename。
   *
   * ⚠️ 与前者的差别：这里的入参本来就是增量，所以不需要 `written` 基线
   *（基线的作用正是「从全量里算出增量」，而账本已经把增量算好了）。
   *
   * ⚠️ **零增量不写盘**（与 gemini-sigstore 的脏检查同款）：避免无谓的
   *「全量读 + parse + stringify + 原子写」，且能防止「盘上被外部删除的日桶
   * 又被内存里残留的 0 增量重新建成空壳」。
   */
  async save(delta: CreditUsageDaysDocument): Promise<CreditUsageDocument> {
    const incoming = normalizeDays(delta)
    if (!hasAnyDay(incoming)) return this.readFile()
    const merged = mergeDocument(this.readFile(), incoming)
    pruneOldDays(merged)
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8')
    renameSync(tmp, this.path)
    return merged
  }
}

/** 深拷贝文档（避免调用方与后端共享引用）。 */
function cloneDocument(document: CreditUsageDocument): CreditUsageDocument {
  return JSON.parse(JSON.stringify(document)) as CreditUsageDocument
}

/**
 * 把「日桶增量」归一成合法文档。
 *
 * 增量文档不带 `schema`（那只是落盘格式的版本标记，由本文件负责），
 * 故这里补一个空串再走与读盘完全相同的清洗逻辑 —— 两条路径共用一套钳制，
 * 不会出现「盘上的数据被清洗、内存增量没被清洗」的不对称。
 */
function normalizeDays(delta: CreditUsageDaysDocument): CreditUsageDocument {
  return sanitizeCreditUsageDocument({ schema: SCHEMA, providers: delta?.providers ?? {} })
}

/** 文档里是否有任何日桶。 */
function hasAnyDay(document: CreditUsageDocument): boolean {
  return Object.values(document.providers).some(entry => entry.days.length > 0)
}

/**
 * 把 `incoming` 的日桶合并进 `base`（返回新文档，不改入参）。
 *
 * ## 合并运算的选择（必须在注释里写死前提，否则下一个人会改错）
 *
 * - `spent` / `gained` 是**可加计数器** ⇒ 逐值**相加**。两个实例各自记了
 *   今天的 100 和 50，合并后是 150 —— 它们来自**不同的余额差值区间**，
 *   相加才是真实消耗。
 *   ⚠️ 前提：入参是**增量**。若哪天改成传全量，就必须换成「取较大值，
 *   并保留 `written` 基线」，否则会翻倍（`token-ledger-store` 正是那种形态）。
 * - `accountIds` 是**集合** ⇒ 取**并集**（{@link mergeAccountIds}）。这是唯一
 *   在「重复 flush / 多实例 / 重启」下都幂等的运算。
 * - `accounts` 是**集合的基数**，因此合并后要用并集长度重算，而不是相加、
 *   也不是取较大值：
 *   - 相加 ⇒ 同一账号被两个实例各记一次会算成 2 个人（旧的 `Math.max`
 *     则是另一个方向的错：跨 flush 窗口卡住不前移，Tester 已复现）；
 *   - 重算 = `max(并集长度, 两侧各自的旧数字)`，兼容没有集合的老文档
 *    （{@link accountCountOf} 的口径，取大是保守方向）。
 */
export function mergeDocument(base: CreditUsageDocument, incoming: CreditUsageDaysDocument): CreditUsageDocument {
  const result = cloneDocument(base)
  for (const [provider, entry] of Object.entries(incoming.providers)) {
    const target = result.providers[provider] ?? { days: [] }
    const byDay = new Map(target.days.map(row => [row.day, { ...row }]))
    for (const row of entry.days) {
      const existing = byDay.get(row.day)
      if (existing === undefined) {
        byDay.set(row.day, { ...row, accounts: accountCountOf(row) })
        continue
      }
      const accountIds = mergeAccountIds(existing.accountIds, row.accountIds)
      byDay.set(row.day, {
        day: row.day,
        spent: existing.spent + row.spent,
        gained: existing.gained + row.gained,
        accounts: Math.max(accountIds.length, accountCountOf(existing), accountCountOf(row)),
        ...accountIds.length > 0 ? { accountIds } : {},
      })
    }
    result.providers[provider] = { days: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)) }
  }
  pruneOldDays(result)
  return result
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
