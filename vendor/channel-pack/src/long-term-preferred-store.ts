/**
 * 「长期积分优先账号」表的**独立**持久化文档。
 *
 * ## 它存什么
 *
 * 每个双池 provider（当前仅 Raccoon）可指定一个账号 id：当每日积分全部
 * 用尽、选号落到长期档时，**该账号的长期积分先烧**，其余账号仍按手动
 * 顺序。键为 provider，值为账号 id；缺键 = 跟随手动顺序。
 *
 * ## 为什么是独立文档（与 `permanent-locks.json` 同一理由）
 *
 * `$DSH_HOME/channel-pack/state.json` 是 dsh home 级、同机多 profile 共享
 * 的，而插件的存储是**整体替换**语义 —— 另一条工作区里不认识本键的旧
 * 版本代码任意一次全量写入都会把它抹掉。锁定表因此拆出了独立文档
 * （见 `src/permanent-lock-store.ts` 文件头的完整分析），本表沿用同一
 * 结论，避免重蹈覆辙。
 *
 * 与锁定表的两点差异：
 * - **无旧版迁移**：本表是全新字段，state.json 里从来没有过它的前身；
 * - **丢失后果较轻**：丢键只回到手动顺序（可逆的展示偏好级别），不像
 *   丢锁定那样会误烧永久积分 —— 但仍独立成文，行为一致才好维护。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveChannelPackHome } from './channel-pack-store.js'

/** 独立文档的文件名（与 state.json / permanent-locks.json 同目录）。 */
export const LONG_TERM_PREFERRED_FILE = 'long-term-preferred.json'

/** provider → 优先消耗长期积分的账号 id。 */
export type LongTermPreferredMap = Record<string, string>

/** 把任意输入归一成合法的优先表：值必须是非空字符串（账号 id）。 */
export function sanitizeLongTermPreferred(raw: unknown): LongTermPreferredMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: LongTermPreferredMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0 && provider.length > 0) result[provider] = value
  }
  return result
}

/** 后端的种类：文件（正常）或内存（无法定位 home 时的显式降级）。 */
export type LongTermPreferredStoreKind = 'file' | 'memory'

/** 读取结果：区分「文档不存在」与「存在但是空表」。 */
export type LongTermPreferredRead =
  | { exists: false; preferred: LongTermPreferredMap }
  | { exists: true; preferred: LongTermPreferredMap }

/** 独立文档的读写接口（同步读、异步写，与 `PermanentLockStore` 同款约定）。 */
export interface LongTermPreferredStore {
  readonly kind: LongTermPreferredStoreKind
  /** 载入优先表；文档不存在时 `exists: false`。 */
  load(): LongTermPreferredRead
  /** 整体写入优先表（原子写）。 */
  save(preferred: LongTermPreferredMap): Promise<void>
}

/** 仅内存后端：无法定位 dsh home 时的显式降级。 */
class MemoryPreferredStore implements LongTermPreferredStore {
  readonly kind = 'memory' as const
  private preferred: LongTermPreferredMap = {}
  private written = false

  load(): LongTermPreferredRead {
    return { exists: this.written, preferred: { ...this.preferred } }
  }

  async save(preferred: LongTermPreferredMap): Promise<void> {
    this.preferred = { ...preferred }
    this.written = true
  }
}

/** 文件后端：`$DSH_HOME/channel-pack/long-term-preferred.json`（原子写：tmp + rename）。 */
class FilePreferredStore implements LongTermPreferredStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): LongTermPreferredRead {
    try {
      if (!existsSync(this.path)) return { exists: false, preferred: {} }
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      return { exists: true, preferred: sanitizeLongTermPreferred(preferredFieldOf(parsed)) }
    } catch (error) {
      // 损坏时按「文档存在但空表」处理：回到手动顺序是安全方向（丢失的
      // 只是可重设的偏好，不会误烧积分）。
      this.logger?.warn(`[channel-pack] 读取 ${this.path} 失败，按手动顺序处理: ${String(error)}`)
      return { exists: true, preferred: {} }
    }
  }

  async save(preferred: LongTermPreferredMap): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    // 带 schema 标记：与本仓库其它状态文档同惯例，便于将来演进时判别。
    writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, preferred }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

const SCHEMA = 'dsh-codearts-auth/long-term-preferred/v1'

/**
 * 取出文档里的优先表字段，同时兼容**裸表**形态（顶层直接
 * `{ raccoon: "id-xxx" }`）：手工编辑过的文档按裸表认，比当空表更安全。
 */
function preferredFieldOf(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed
  const record = parsed as Record<string, unknown>
  if (record.preferred !== undefined) return record.preferred
  if (record.schema === undefined) return record
  return {}
}

/**
 * 创建优先表后端。home 的解析与账号池**同一个函数**
 * （`resolveChannelPackHome`），保证三份文档永远落在同一目录。
 */
export function createLongTermPreferredStore(ctx: Context): LongTermPreferredStore {
  const home = resolveChannelPackHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[channel-pack] 无法定位 DSH home，长期积分优先账号仅存在于内存中')
    return new MemoryPreferredStore()
  }
  return new FilePreferredStore(join(home, 'channel-pack', LONG_TERM_PREFERRED_FILE), ctx.logger)
}
