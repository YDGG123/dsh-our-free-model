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
  /** 当日采样到的账号数。 */
  accounts: number
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

  /** 已落盘的文档（增量 flush 的基线；内存态与磁盘态的差只来自本轮）。 */
  private persisted: { providers: Record<string, { days: CreditUsageDay[] }> } = { providers: {} }
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
    row.accounts = accounts.size
  }

  /** 只保留最近 {@link MAX_DAYS} 天（日键可字典序比较）。 */
  private pruneDays(perProvider: Map<string, CreditUsageDay>): void {
    if (perProvider.size <= MAX_DAYS) return
    const keys = [...perProvider.keys()].sort()
    for (const key of keys.slice(0, keys.length - MAX_DAYS)) perProvider.delete(key)
  }

  /**
   * 数据看板读取：今日汇总 + 最近 N 天 + 今日按账号明细。
   *
   * 「最近 N 天」是**内存与磁盘的并集**：历史日桶已 flush 到盘上，今日的数字
   * 还在内存里。只看一边都会漏（只看磁盘＝今天全是 0；只看内存＝重启后历史
   * 全丢）。合并规则：同一天取**较大值**（内存 ≥ 磁盘，两者同源）。
   */
  snapshot(provider: string, days = 30): CreditUsageSnapshot {
    const today = utc8DayKey(this.now())
    const merged = new Map<string, CreditUsageDay>()
    for (const row of this.persisted.providers[provider]?.days ?? []) merged.set(row.day, { ...row })
    for (const row of (this.days.get(provider) ?? new Map<string, CreditUsageDay>()).values()) {
      const existing = merged.get(row.day)
      merged.set(row.day, existing === undefined ? { ...row } : {
        day: row.day,
        spent: Math.max(existing.spent, row.spent),
        gained: Math.max(existing.gained, row.gained),
        accounts: Math.max(existing.accounts, row.accounts),
      })
    }
    const sorted = [...merged.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    const todayRow = merged.get(today) ?? { day: today, spent: 0, gained: 0, accounts: 0 }
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

  /** 立即落盘。失败只记日志：记账绝不能反噬选号路径。 */
  async flush(): Promise<void> {
    if (this.persistence === undefined) return
    if (this.flushTimer !== undefined) { clearTimeout(this.flushTimer); this.flushTimer = undefined }
    try {
      const daysByProvider = new Map<string, Map<string, CreditUsageDay>>()
      for (const [provider, entry] of Object.entries(this.persisted.providers)) {
        const map = new Map<string, CreditUsageDay>()
        for (const row of entry.days) map.set(row.day, { ...row })
        daysByProvider.set(provider, map)
      }
      for (const [provider, perDay] of this.days) {
        const map = daysByProvider.get(provider) ?? new Map<string, CreditUsageDay>()
        for (const row of perDay.values()) {
          const existing = map.get(row.day)
          map.set(row.day, existing === undefined ? { ...row } : {
            day: row.day,
            spent: Math.max(existing.spent, row.spent),
            gained: Math.max(existing.gained, row.gained),
            accounts: Math.max(existing.accounts, row.accounts),
          })
        }
        daysByProvider.set(provider, map)
      }
      const providers: Record<string, { days: CreditUsageDay[] }> = {}
      for (const [provider, map] of daysByProvider) {
        providers[provider] = { days: [...map.values()].sort((a, b) => (a.day < b.day ? 1 : -1)) }
      }
      this.persisted = { providers }
      await this.persistence.save(this.persisted)
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
