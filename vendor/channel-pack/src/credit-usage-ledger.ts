/**
 * 每日积分消耗账本：把「余额差值」记成可按日汇总的消耗记录。
 *
 * ## 为什么必须自己记（而不是读上游）
 *
 * 上游只给**剩余量**：`GET /points/v1/balance` 返回各积分包的 `remaining`，
 * 而 `used` 字段实测恒为 0（服务端不填）。扣费公式也没有公开依据 ——
 * Raccoon 的模型目录里虽有 `billing_effective_multiplier`，但「倍率 × 什么
 * 单位 = 多少积分」没有可验证的定义。任何「token × 倍率」的推算都会产出
 * **看起来精确的假数字**，比不显示更糟。
 *
 * 因此本模块只承认一种事实：**相邻两次余额快照的差值**。它自动包含我们
 * 无法建模的一切规则（阶梯计价、赠送抵扣、按次固定费……）。
 *
 * ## 记账时机
 *
 * 采样点必须是「余额真的变了」的时刻。选号器每次选号前都会查余额
 * （`raccoon-balance-selector` 的 60 秒缓存），因此：
 *
 * - 每笔请求结束后记一次（`recordSample`），由调用方传入**刚刚读到的**
 *   余额与**上一次**已知余额；
 * - 差值为负（余额减少）→ 记为消耗；差值为正（发放/充值）→ 记为补给，
 *   不计入消耗；差值为 0 → 不记（省空间，也避免「0 消耗」污染均值）。
 *
 * ⚠️ 缓存命中会让两次采样之间跨过多笔请求：那一段的消耗会**合并**成一条，
 * 金额仍然准确（差值守恒），只是时间粒度粗。这是有意的取舍 —— 宁可粗，
 * 不要假。
 *
 * ## 与 token 账本的关系
 *
 * 两者**独立**：token 账本记模型用量（input/output tokens），本账本记
 * 渠道扣费（积分）。它们的数据源不同、失败模式不同，混在一张表里会让
 * 「余额查询失败」看起来像「没花钱」。
 *
 * @module vendor/channel-pack/src/credit-usage-ledger.ts
 */

/** 一次采样得到的「某账号某积分池」的余额变化。 */
export interface CreditUsageSample {
  /** 采样时刻（毫秒）。 */
  ts: number
  /** provider id（如 `raccoon`）。 */
  provider: string
  /** 账号池条目 id。 */
  accountId: string
  /** 积分池名（如「每日积分」「奖励积分」）。 */
  pool: string
  /** 本段消耗（正数；余额减少量）。补给为 0。 */
  spent: number
  /** 本段补给（正数；余额增加量）。纯消耗时为 0。 */
  gained: number
}

/** 某 provider 某天的汇总。 */
export interface CreditUsageDay {
  /** UTC+8 日键 `YYYY-MM-DD`。 */
  day: string
  /** 当日消耗合计（所有账号、所有池）。 */
  spent: number
  /** 当日补给合计。 */
  gained: number
  /**
   * 当日采样到的账号数。
   *
   * ⚠️ **派生字段**：只要有 {@link accountIds} 就应等于它的长度；老文档没有
   * `accountIds` 时才单独成立（见 {@link mergeAccountIds} 的兼容说明）。
   * 消费方（面板 / `allSnapshot`）继续读这个数字即可，不必自己数集合。
   */
  accounts: number
  /**
   * 当日**见过的账号 id 集合**（并集语义，落盘用）。
   *
   * ## 为什么需要它（真实缺陷，2026-10-19 Tester 复现）
   *
   * 账号数**没有差值语义**：它不是「可减的计数器」，而是「当日出现过的 id 的
   * 基数」。旧实现把它也塞进差值法（`本次累计 − 上次已写`）+ 后端 `Math.max`，
   * 于是同一实例跨 flush 窗口会卡死：
   *
   * ```
   * 第 1 窗口用账号 A：内存 1，盘 0   → 送 1−0=1，盘 max(0,1)=1
   * 第 2 窗口用账号 B：内存 2，盘(基线)1 → 送 2−1=1，盘 max(1,1)=1  ← 卡住
   * 第 3 窗口用账号 C：内存 3，基线 3 → 送 3−3=0，被当零增量跳过
   * ```
   *
   * 结果：金额 `spent` 一直正确，但「今日 N 个账号」永远停在 1，重启后更是
   * 永久丢失。触发条件是**常态**（一天里陆续用到第 2、3 个账号，间隔超过
   * 默认 30 秒防抖窗口）。
   *
   * 修法就是存集合：增量只送「基线里还没有的 id」，合并时取**并集**，
   * 重复 flush / 多实例 / 重启都不会重复计数或丢计数。
   */
  accountIds?: string[]
}

/**
 * 合并若干「账号 id 集合」为并集（去重、保持首次出现的顺序）。
 *
 * ## 向后兼容：老文档没有 `accountIds`
 *
 * 修复前落盘的日桶只有数字 `accounts`。那种数据**无法还原**具体是哪些账号，
 * 故调用方应当用 {@link accountCountOf} 处理「集合 + 老数字」并存的场景
 * （取二者较大值：集合是精确认知，老数字是历史下界）。
 */
export function mergeAccountIds(
  ...lists: ReadonlyArray<readonly string[] | undefined>
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    if (list === undefined) continue
    for (const id of list) {
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * 一天的「账号数」：有集合用集合基数，没有就退回老数字，两者都有取较大值。
 *
 * 取较大值是**刻意的保守方向**：集合是精确认知，老数字是历史下界，任何一方
 * 更大都说明另一方漏了；取小会把「确实用过」的账号显示丢掉。
 */
export function accountCountOf(row: { accounts?: number; accountIds?: readonly string[] } | undefined): number {
  if (row === undefined) return 0
  const ids = row.accountIds?.length ?? 0
  const legacy = Number.isFinite(row.accounts) ? Number(row.accounts) : 0
  return Math.max(ids, legacy)
}

/** 单个账号在某天的消耗明细。 */
export interface CreditUsageAccountDay {
  accountId: string
  /** 账号昵称（采样时的快照，账号改名后历史仍显示当时的名字）。 */
  nickname?: string
  spent: number
  gained: number
  /** 按池拆分：池名 → 消耗。 */
  pools: Record<string, number>
}

/** 完整快照（供数据看板读取）。 */
export interface CreditUsageSnapshot {
  provider: string
  /** 今日（UTC+8）汇总；无数据时 spent/gained 为 0。 */
  today: CreditUsageDay
  /** 最近 N 天（含今日），按日键倒序。 */
  days: CreditUsageDay[]
  /** 今日按账号明细，按消耗降序。 */
  accounts: CreditUsageAccountDay[]
  /** 采样总条数（诊断用：0 说明还没开始记）。 */
  samples: number
}

/** 内存里保留的采样条数上限（超出后按日折叠，见 {@link CreditUsageLedger.record}）。 */
const MAX_SAMPLES = 2000
/** 按日保留的天数上限。 */
const MAX_DAYS = 90

/** UTC+8 日键 —— 与 `token-ledger.ts` 的 `utc8DayKey` 同一纪律（算术换算，不用本机时区）。 */
export function utc8DayKey(ts: number): string {
  const shifted = new Date(ts + 8 * 60 * 60 * 1000)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${month}-${day}`
}

/** 某个账号上一次已知的各池余额（记账的基线）。 */
export type CreditBaseline = Record<string, number>

/**
 * 「按日聚合的日桶」文档形状（不含 schema 字段）。
 *
 * 账本只关心日桶，持久化后端（`credit-usage-store.ts`）在它之上再加
 * `schema` 版本标记。两处共用这一个形状，避免「账本以为是全量、后端以为是
 * 增量」这类签名歧义 —— 那正是本次修复要消灭的缺陷形态。
 */
export interface CreditUsageDaysDocument {
  providers: Record<string, { days: CreditUsageDay[] }>
}

/**
 * 持久化后端契约（由 `credit-usage-store.ts` 实现）。
 *
 * ## ⚠️ `save()` 的入参是**增量**，返回的是**合并后**的完整文档
 *
 * 账本把「相对上次成功落盘的新增部分」交给后端，后端负责重读盘上现况再合并
 * （两个实例并存时各自的贡献互不覆盖）。返回值必须回传，否则账本无从知道
 * 「盘上还有别人写的部分」—— 面板会在重启后一直少读。
 */
export interface CreditUsagePersistence {
  /** 载入盘上现况；不存在时返回空文档。 */
  load(): CreditUsageDaysDocument
  /** 把增量合并进盘上现况，返回合并结果。 */
  save(delta: CreditUsageDaysDocument): Promise<CreditUsageDaysDocument>
}

/**
 * 每日积分消耗账本（进程内 + 按日折叠）。
 *
 * 生命周期与插件实例一致；跨重启的持久化由调用方（RPC 层）负责落盘 ——
 * 本模块只管计算与聚合，便于单测注入时间。
 */
export class CreditUsageLedger {
  /** provider → accountId → 各池上次已知余额。 */
  private readonly baselines = new Map<string, Map<string, CreditBaseline>>()
  /** 原始采样（用于最近明细）；超出上限时最老的先丢（按日汇总已保留）。 */
  private readonly samples: CreditUsageSample[] = []
  /** provider → 日键 → 汇总。 */
  private readonly days = new Map<string, Map<string, CreditUsageDay>>()
  /** provider → 日键 → accountId → 明细。 */
  private readonly accountDays = new Map<string, Map<string, Map<string, CreditUsageAccountDay>>>()

  /**
   * 盘上现况（含**别的实例**写下的日桶）。
   *
   * 只读语义：它代表「已经进入持久化层的部分」，与内存 `days` 的关系见
   * {@link written}。合并展示时不能简单取较大值 —— 两者是**可加计数器**
   *（见 {@link snapshot} 的合并算法）。
   */
  private persisted: { providers: Record<string, { days: CreditUsageDay[] }> } = { providers: {} }
  /**
   * **已落盘基线**：上次成功写盘时本实例内存 `days` 的快照。
   *
   * `flush()` 只把「内存 − written」这段增量交给后端（后端再与盘上现况合并）。
   * 有了它，两个实例并存时各自的贡献互不覆盖：A 写 100、B 写 50 ⇒ 盘上 150。
   * 这正是审计发现的真实缺陷（旧实现整体覆盖，后写者抹掉先写者）。
   */
  private written = new Map<string, Map<string, CreditUsageDay>>()
  /** 节流：落盘定时器。 */
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  /** 日志出口（默认静默；宿主注入）。 */
  private onLog: ((message: string) => void) | undefined

  constructor(
    private readonly now: () => number = Date.now,
    private readonly persistence?: CreditUsagePersistence,
    private readonly flushDebounceMs: number = 30_000,
  ) {
    if (persistence !== undefined) {
      try {
        const loaded = persistence.load()
        if (loaded !== undefined && loaded !== null) this.persisted = loaded
      } catch (error) {
        this.log(`load failed (${error instanceof Error ? error.message : String(error)})`)
      }
    }
  }

  /**
   * 用**刚读到的余额**更新基线并记一笔。
   *
   * @param provider provider id
   * @param accountId 账号池条目 id
   * @param nickname 账号昵称（写进当日明细，便于展示）
   * @param balances 本次读到的「池名 → 剩余」。首次见到该账号时只建基线、不记账
   *   （没有上一次可比，无法知道消耗）；之后每次与基线求差。
   * @returns 本次记下的采样（首次建基线或余额未变时返回空数组）
   */
  record(provider: string, accountId: string, nickname: string | undefined, balances: CreditBaseline): CreditUsageSample[] {
    const ts = this.now()
    const day = utc8DayKey(ts)
    let perProvider = this.baselines.get(provider)
    if (perProvider === undefined) { perProvider = new Map(); this.baselines.set(provider, perProvider) }
    const previous = perProvider.get(accountId)
    perProvider.set(accountId, { ...balances })
    // 首次见到该账号：只建基线。没有上一次读数，任何差值都是臆造。
    if (previous === undefined) return []

    const written: CreditUsageSample[] = []
    for (const [pool, current] of Object.entries(balances)) {
      const before = previous[pool]
      // 新增的池（此前没有该字段）同样无法求差，跳过并已在上文更新基线。
      if (before === undefined) continue
      const delta = before - current
      if (delta === 0) continue
      const sample: CreditUsageSample = {
        ts,
        provider,
        accountId,
        pool,
        spent: delta > 0 ? delta : 0,
        gained: delta < 0 ? -delta : 0,
      }
      this.pushSample(sample)
      this.accumulate(sample, day, nickname)
      written.push(sample)
    }
    return written
  }

  private pushSample(sample: CreditUsageSample): void {
    this.samples.push(sample)
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES)
  }

  private accumulate(sample: CreditUsageSample, day: string, nickname: string | undefined): void {
    let perProvider = this.days.get(sample.provider)
    if (perProvider === undefined) { perProvider = new Map(); this.days.set(sample.provider, perProvider) }
    const row = perProvider.get(day) ?? { day, spent: 0, gained: 0, accounts: 0 }
    row.spent += sample.spent
    row.gained += sample.gained
    perProvider.set(day, row)
    this.pruneDays(perProvider)

    let perDay = this.accountDays.get(sample.provider)
    if (perDay === undefined) { perDay = new Map(); this.accountDays.set(sample.provider, perDay) }
    let accounts = perDay.get(day)
    if (accounts === undefined) { accounts = new Map(); perDay.set(day, accounts) }
    const account = accounts.get(sample.accountId) ?? { accountId: sample.accountId, nickname, spent: 0, gained: 0, pools: {} }
    account.spent += sample.spent
    account.gained += sample.gained
    if (nickname !== undefined && nickname.length > 0) account.nickname = nickname
    if (sample.spent > 0) account.pools[sample.pool] = (account.pools[sample.pool] ?? 0) + sample.spent
    accounts.set(sample.accountId, account)
    // 账号数 = 「当日见过的 id 集合」基数（并集语义）。明细表本身就是那份集合，
    // 故直接取它的大小，同时把 id 写进日桶 —— 落盘要能跨重启/跨实例求并集。
    row.accountIds = [...accounts.keys()]
    row.accounts = row.accountIds.length
  }

  /** 只保留最近 {@link MAX_DAYS} 天（日键可字典序比较）。 */
  private pruneDays(perProvider: Map<string, CreditUsageDay>): void {
    if (perProvider.size <= MAX_DAYS) return
    const keys = [...perProvider.keys()].sort()
    for (const key of keys.slice(0, keys.length - MAX_DAYS)) perProvider.delete(key)
  }

  /**
   * 全渠道概览：遍历账本里**实际有数据的 provider**（内存 ∪ 磁盘），
   * 逐个取快照并按日汇总。
   *
   * ⚠️ 不维护一份手工的 provider 清单 —— 那会和记账面漂移（新增/停用渠道
   * 时忘改这里，tab 就会出现「点了全 0」的死入口）。「有数据才出现」
   * 的语义由数据本身保证。
   *
   * @returns providers 按名字排序的各渠道快照；days 是全部渠道按日合并的
   *   总消耗；samples 是全部渠道的采样总数。
   */
  allSnapshot(days = 30): {
    providers: CreditUsageSnapshot[]
    today: CreditUsageDay
    days: CreditUsageDay[]
    samples: number
  } {
    const today = utc8DayKey(this.now())
    const providerIds = new Set<string>([
      ...this.days.keys(),
      ...Object.keys(this.persisted.providers),
    ])
    const providers = [...providerIds].sort().map(id => this.snapshot(id, days))
    const byDay = new Map<string, CreditUsageDay>()
    for (const entry of providers) {
      for (const row of entry.days) {
        const existing = byDay.get(row.day)
        if (existing === undefined) {
          byDay.set(row.day, { ...row })
          continue
        }
        // 跨渠道汇总：账号数按**集合**求并（同一账号不会跨 provider 重复，
        // 但集合运算比累加更稳：重复调用 / 未来 provider 合并都不会翻倍）。
        // 没有集合的老数据退回累加（与旧行为一致）。
        const accountIds = mergeAccountIds(existing.accountIds, row.accountIds)
        byDay.set(row.day, {
          day: row.day,
          spent: existing.spent + row.spent,
          gained: existing.gained + row.gained,
          /**
           * **跨渠道的账号数 = 各渠道相加**（与升级前的语义一致），不是并集、
           * 也不是取较大值。
           *
           * ## 为什么是相加（2026-10-19 Tester 复现后对账）
           *
           * 账号 id 是**带 provider 前缀**的池条目 id（`raccoon-6c9bfc87`、
           * `buddy-bfc5feec`），**跨渠道永不相同** —— 所以「并集」与「相加」
           * 在 id 齐全时完全等价，一旦某侧是老数据（没有 id），并集就会把它的
           * 数字**抹掉**。本机真实数据正是这种混合形态：
           *
           * ```
           * raccoon 10-19: {accounts: 2, accountIds: ['raccoon-6c9bfc87']}  ← 老数字 2、集合 1 个
           * buddy   10-19: {accounts: 1, accountIds: ['buddy-bfc5feec']}
           * 真值 = 3（两个渠道 2 + 1 个账号）；并集 = 2 ✗
           * ```
           *
           * ⚠️ 注意 `Math.max(并集长度, 两侧数字)` 在这里同样得 2 —— 它能让
           * 单渠道视图不倒退，但**跨渠道必须相加**才符合「全部渠道共用了几个
           * 账号」这个问题。两个口径不能互相推导，各自写死。
           *
           * `accountCountOf` 负责把「老数字下界」与「集合基数」在**每个渠道
           * 内部**先取较大值，再加总 —— 于是老渠道也不会因为集合只有 1 个 id
           * 就被当成 1 个账号。
           */
          accounts: accountCountOf(existing) + accountCountOf(row),
          ...accountIds.length > 0 ? { accountIds } : {},
        })
      }
    }
    const allDays = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    return {
      providers,
      today: byDay.get(today) ?? { day: today, spent: 0, gained: 0, accounts: 0 },
      days: allDays.slice(0, Math.max(1, Math.trunc(days))),
      samples: providers.reduce((sum, entry) => sum + entry.samples, 0),
    }
  }

  /**
   * 数据看板读取：今日汇总 + 最近 N 天 + 今日按账号明细。
   *
   * 「最近 N 天」是**内存与磁盘的并集**：历史日桶已 flush 到盘上，今日的数字
   * 还在内存里。只看一边都会漏（只看磁盘＝今天全是 0；只看内存＝重启后历史
   * 全丢）。
   *
   * ## ⚠️ 合并是**加法**，不是 `Math.max`（真实缺陷，2026-10-19 审计发现）
   *
   * `spent` / `gained` 是**可加计数器**。旧实现取较大值，前提是「内存是磁盘的
   * 超集」—— 那只在**单实例**下成立：本实例内存的今日累计确实 ≥ 磁盘上
   * 「本实例上次写的值」。但两个实例并存时（同机多 profile、fiber 重启交错），
   * 各自记 100，盘上 100、内存 100，取较大值仍是 100（真值 200）。
   *
   * 现在的算法：**磁盘值 + 本实例尚未落盘的增量**（内存 − {@link written}）。
   * 单实例下与本实例内存值完全相等（增量 = 内存 − 上次写的），多实例下
   * 得到的是「盘上别人的 + 我新记的」，不再互相掩盖。
   *
   * ## ⚠️ `accounts` 走**集合并集**，不走差值（真实缺陷，2026-10-19 Tester 复现）
   *
   * 账号数是「当日见过的 id 的基数」，没有差值语义。旧实现把它也当计数器，
   * 于是跨 flush 窗口卡死（`credit-usage-ledger.ts` 的 `CreditUsageDay.accountIds`
   * 注释里有完整推演）。现在合并的是**集合**：盘上集合 ∪ 内存集合，再取基数；
   * 老文档没有集合时退回它自己的数字（{@link accountCountOf}）。
   */
  snapshot(provider: string, days = 30): CreditUsageSnapshot {
    const today = utc8DayKey(this.now())
    const merged = new Map<string, CreditUsageDay>()
    for (const row of this.persisted.providers[provider]?.days ?? []) merged.set(row.day, { ...row })
    const mine = this.days.get(provider)
    const base = this.written.get(provider)
    if (mine !== undefined) {
      for (const row of mine.values()) {
        const previous = base?.get(row.day)
        // 未落盘增量：本实例内存值减去上次写盘时的值（负数钳到 0，防手工编辑倒挂）。
        const spent = Math.max(0, row.spent - (previous?.spent ?? 0))
        const gained = Math.max(0, row.gained - (previous?.gained ?? 0))
        const existing = merged.get(row.day)
        if (existing === undefined) {
          merged.set(row.day, { ...row, spent, gained, accounts: accountCountOf(row) })
          continue
        }
        // 账号：集合求并集（不是相加、也不是取较大值）。
        const accountIds = mergeAccountIds(existing.accountIds, row.accountIds)
        merged.set(row.day, {
          day: row.day,
          spent: existing.spent + spent,
          gained: existing.gained + gained,
          accounts: Math.max(accountIds.length, accountCountOf(existing), accountCountOf(row)),
          ...accountIds.length > 0 ? { accountIds } : {},
        })
      }
    }
    const sorted = [...merged.values()]
      .map(row => ({ ...row, accounts: accountCountOf(row) }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    const todayRow = sorted.find(row => row.day === today)
      ?? { day: today, spent: 0, gained: 0, accounts: 0 }
    const accounts = [...(this.accountDays.get(provider)?.get(today)?.values() ?? [])]
      .sort((a, b) => b.spent - a.spent)
    return {
      provider,
      today: todayRow,
      days: sorted.slice(0, Math.max(1, Math.trunc(days))),
      accounts,
      samples: this.samples.filter(sample => sample.provider === provider).length,
    }
  }

  /**
   * 立即落盘。失败只记日志：记账绝不能反噬选号路径。
   *
   * ## 增量语义（真实缺陷修复，2026-10-19）
   *
   * 旧实现把**内存全量**交给后端，而 `FileUsageStore` 是整体覆盖 ⇒ 两个实例
   * 并存时后写者抹掉先写者（审计已复现：A 记 100、B 记 5，最后盘上只剩 5）。
   *
   * 现在只交「相对 {@link written} 的增量」，后端负责重读盘上现况再合并，
   * 回传合并后的完整文档 —— 本实例立刻用它更新 {@link persisted}，于是
   * 刚写下的东西不必等下次重启就能在面板里看到（旧实现 flush 后仍只读
   * 自己那份内存视图，重启前的历史要等重载才出现）。
   */
  async flush(): Promise<void> {
    if (this.persistence === undefined) return
    if (this.flushTimer !== undefined) { clearTimeout(this.flushTimer); this.flushTimer = undefined }
    try {
      // ① 算出增量（内存 − 上次写盘基线，负数钳到 0 防手工编辑倒挂）。
      const delta: Record<string, { days: CreditUsageDay[] }> = {}
      let hasDelta = false
      for (const [provider, perDay] of this.days) {
        const base = this.written.get(provider)
        const rows: CreditUsageDay[] = []
        for (const row of perDay.values()) {
          const previous = base?.get(row.day)
          const spent = Math.max(0, row.spent - (previous?.spent ?? 0))
          const gained = Math.max(0, row.gained - (previous?.gained ?? 0))
          /**
           * 账号：只送**基线里还没有的 id**（集合增量），绝不送数量差值。
           *
           * 旧实现送 `row.accounts − previous.accounts`，后端再取 `Math.max`，
           * 于是第 2 个窗口送的 2−1=1 与盘上的 1 取大仍是 1、第 3 个窗口送的
           * 3−3=0 直接被当零增量跳过 —— 计数从此不再前移（Tester 已复现）。
           * 集合增量没有这个问题：并集天然幂等且可重复合并。
           */
          const previousIds = new Set(previous?.accountIds ?? [])
          const newIds = (row.accountIds ?? []).filter(id => !previousIds.has(id))
          // 老文档没有集合（`accountIds` 缺失）：只有当内存里的数字比基线大时才
          // 送数量 —— 这时没有 id 可送，退化成旧语义（至少不会倒退）。
          const legacyDelta = row.accountIds === undefined || row.accountIds.length === 0
            ? Math.max(0, row.accounts - (previous?.accounts ?? 0))
            : 0
          if (spent === 0 && gained === 0 && newIds.length === 0 && legacyDelta === 0) continue
          rows.push({
            day: row.day,
            spent,
            gained,
            // 数量字段始终填**本日总量**（不是增量）：后端合并时按集合重算基数，
            // 这个数字只作为「老数据兜底」与并集基数一起参与取大。填增量会让
            // 没有集合的消费方（老前端 / 老文档）读到一个毫无意义的数。
            accounts: accountCountOf(row),
            ...newIds.length > 0 ? { accountIds: newIds } : {},
          })
        }
        if (rows.length === 0) continue
        hasDelta = true
        delta[provider] = { days: rows }
      }
      // ⚠️ 没有任何增量 ⇒ 什么都不写（与 `token-ledger-store` 的脏检查同款）。
      if (!hasDelta) return
      // ② 交给后端合并写入；它返回**合并后**的完整文档。
      const merged = await this.persistence.save({ providers: delta })
      if (merged !== undefined && merged !== null && typeof merged === 'object') {
        this.persisted = { providers: merged.providers ?? this.persisted.providers }
      }
      // ③ 基线前移（只在写盘成功后）。
      this.written = new Map()
      for (const [provider, perDay] of this.days) {
        this.written.set(provider, new Map([...perDay].map(([day, row]) => [day, { ...row }])))
      }
    } catch (error) {
      this.log(`flush failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  /** 节流落盘（防抖窗口内的多次记账只写一次盘）。 */
  scheduleFlush(): void {
    if (this.persistence === undefined || this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.flush() }, this.flushDebounceMs)
    this.flushTimer.unref?.()
  }

  /**
   * 采样入口（供 RPC 层直接使用；不需要构造新的闭包）。
   *
   * 与 {@link record} 的差别：本方法自带异常吞噬（记账是尽力而为），
   * 并在记账后安排节流落盘 —— 调用方无需关心这两件事。
   */
  sample(provider: string, accountId: string, balances: Record<string, number>): void {
    try {
      this.record(provider, accountId, undefined, balances)
      this.scheduleFlush()
    } catch { /* 尽力而为 */ }
  }

  /** 安装日志出口（宿主侧调用）。 */
  setLogger(logger: (message: string) => void): void {
    this.onLog = logger
  }
  private log(message: string): void {
    this.onLog?.(message)
  }

  /** 清空某 provider 的全部记账（测试与「重置统计」用）。 */
  reset(provider?: string): void {
    if (provider === undefined) {
      this.baselines.clear(); this.days.clear(); this.accountDays.clear(); this.samples.length = 0
      return
    }
    this.baselines.delete(provider)
    this.days.delete(provider)
    this.accountDays.delete(provider)
    for (let index = this.samples.length - 1; index >= 0; index -= 1) {
      if (this.samples[index]!.provider === provider) this.samples.splice(index, 1)
    }
  }
}
