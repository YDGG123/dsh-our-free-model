# 积分消耗漏记修复：发消息路径节流采样 + 账本落盘缺陷 + TRAE used 对照

日期：2026-10-19　范围：`vendor/channel-pack`（插件本体）、`client.js`、离线套件

## 背景与根因

用户报障「TRAE 积分消耗少记约 10 倍」。Tester 的只读诊断（见群内报告）定位出两层问题：

1. **采样面缺失（主因）**。积分消耗账本 `credit-usage-ledger.ts` 只承认「相邻两次余额
   读数的差值」，而八家渠道（trae / codearts / lobsterai / minimax / gemini / qoder /
   qodercn / cline / zcode）的**唯一**采样入口是渠道面板的 `credits.balances`
   （客户端 90 秒轮询）。
   - 面板不开 ⇒ 对话期间**一次读数都没有** ⇒ 差值法无从计算。
   - 本机证据：`credit-usage.json` 里**没有 `trae` 桶**，而 `state.json` 中
     `trae-bea66e68` 是启用账号 —— 该账号从未产生过一次有效采样差值。
   - 八家同病；`opencode` 无余额端点（不采样，属正常）；`raccoon` 是发消息路径
     高质量采样，buddy 系「有但粗」（60 秒 TTL）。
2. **账本落盘两处与注释相反**：
   - `credit-usage-store.ts` 的 `save()` 是**整体覆盖**，注释却声称「增量合并」
     ⇒ 两实例并存时后写者抹掉先写者。
   - 同日合并用 `Math.max` ⇒ 跨实例时两个实例各记 100，合并后只剩 100（真值 200）。

## 改动文件

### 任务 A：发消息路径节流采样（主线）

1. **`vendor/channel-pack/src/credit-usage-sampler.ts`（新增）** —— 八家共用的采样器。
   - 按 **provider + accountId** 节流，默认 60 秒，`DSH_CHANNEL_PACK_CREDIT_SAMPLE_MS`
     可覆盖（`0` 合法 = 不节流）。⚠️ 节流键必须带账号：只按 provider 会让多账号互相饿死。
   - `sample()` 立即返回、请求在后台跑（调用方 `void` 掉），**不阻塞凭据解析**。
   - 同一账号的并发采样只发一次上游请求（在飞去重）。
   - 失败全吞：只写一行日志，绝不影响发消息主路径。
   - `creditBalancePools()` 与面板路径**同口径**（只取 `active` 包）；空 `packages`
     时退到汇总数 —— MiniMax 的余额响应把 `details` 折叠成 `total`、`packages` 恒空，
     没有这层兜底它永远记不到账。有包时**不用**汇总数（否则双倍记账）。

2. **`vendor/channel-pack/src/index.ts`** —— 八家挂载点（都在 `resolveCredential` 里）：

   | 渠道 | 挂载点 | 复用的余额函数 | 备注 |
   |---|---|---|---|
   | codearts | `index.ts` codearts 分支 | `fetchCodeArtsAccountInfo` | 非积分账户（`credit === undefined`）自然跳过 |
   | lobsterai | LOBSTERAI 分支 | `fetchLobsteraiCreditBalance` | — |
   | qoder / qodercn | 两个分支各自 | `fetchQoderCreditBalance` | provider 分别用 `QODER.id` / `QODER_CN.id`，桶不串 |
   | trae | TRAE 分支 | `fetchTraeCreditBalance` | 只读端点（`require_usage`），60s 节流 |
   | cline | CLINE 分支 | `fetchClineCreditBalance` | — |
   | minimax | MINIMAX 分支 | `fetchMinimaxCreditBalance` | 靠汇总数兜底 |
   | gemini | GEMINI 分支 | `fetchGeminiCreditBalance({ force: true })` | **必须 force**：60 秒配额缓存与节流窗口同量级，否则读数被缓存吃掉 |
   | zcode | ZCODE 分支 | `zcode.fetchBalanceFor` | 逐桶按 `show_name` 记账（量纲是 token）；**captcha 签到流程一行未动** |

   - `opencode` 不挂（无余额端点）。
   - 顺带修复一处既有隐患：`creditUsage.setLogger` / 采样器 `warn` 原先引用**从未定义**
     的裸 `logger`，落盘失败时回调会抛 `ReferenceError`，把唯一的诊断线索吞成
     `flush failed (logger is not defined)`。现统一改为 `ctx.logger?.warn?.(…)`。

### 任务 B：账本落盘缺陷

3. **`vendor/channel-pack/src/credit-usage-store.ts`**
   - `save(delta)` 改为**真增量合并写**：重读盘上现况 → 把增量累加进去 → 原子 rename，
     并**返回合并后的完整文档**（调用方此前拿不到盘上别人的部分）。
   - 零增量直接返回、不写盘（与 `token-ledger-store` / `gemini-sigstore` 的脏检查同款）。
   - `mergeDocument()` 写死运算前提：`spent`/`gained` 可加 ⇒ **相加**；`accounts`
     ⇒ **按账号 id 集合求并集**（见下节「遗留缺陷修复」—— 最初写成「取较大值」，
     被 Tester 复现出跨 flush 窗口计数卡死的真实缺陷）。
   - 新增 `normalizeDays()`：增量文档走与读盘**完全相同的清洗**，避免两侧钳制口径分叉。
   - 模块头注释更正为与实现一致的描述。

4. **`vendor/channel-pack/src/credit-usage-ledger.ts`**
   - 新增 `CreditUsageDaysDocument` / `CreditUsagePersistence` 契约（此前 `CreditUsagePersistence`
     被引用却**没有定义**），明确 `save()` 收增量、返合并结果。
   - `flush()` 只交「内存 − `written` 基线」的增量，写完用返回的合并文档回灌 `persisted`，
     再把基线前移。A 记 100、B 记 50 ⇒ 盘上 150。
   - `snapshot()` 的合并从 `Math.max` 改为**磁盘值 + 本实例未落盘增量**。单实例下与旧值
     完全相等，多实例下不再互相掩盖。

5. **`vendor/channel-pack/src/channel-pack-rpc.ts`**
   - `credits.usage` 的注释更正：落盘**已存在**（`channel-pack/credit-usage.json`，UTC+8、
     保留 90 天、增量合并写），进程内的只有明细与基线。

### 任务 D：TRAE 上游 `used` × 差值法对照

6. **`vendor/channel-pack/src/types.ts`** —— `RpcCreditsBalanceExtra` 新增两个可选字段：
   - `upstreamUsed`：上游自报累计已用（TRAE 独有：`usage.credits_amount` 有真实值，
     其余渠道恒 0，故不传）+ 口径说明。
   - `recordedSpent`：本插件按差值法记的**今日**消耗 + 口径说明。
   - 口径文案由后端给（前端不本地化），措辞改一处即可。

7. **`vendor/channel-pack/src/channel-pack-rpc.ts`** —— TRAE 的 `credits.balances` 分支
   为每行补 `extra.upstreamUsed` / `extra.recordedSpent`。
   ⚠️ 两个数字**只并排、不相减**：上游按资源包周期累计（包轮换会重置），差值法是 UTC+8
   今日聚合。相减得出的「今日漏记 X」是假精度。

8. **`client.js`** —— 账号行新增一处徽标：`上游累计已用 N · 今日差值 M`，hover 显示两条
   口径说明。口径不同故不做任何换算；没有 `extra` 的渠道完全不渲染（零影响）。

9. **`vendor/channel-pack/pack.js`** —— 重新构建（3.03 MiB）。

### 测试

10. **`scripts/credit-sampling-test.mjs`（新增，12 项）**：节流窗口边界 / 多账号不饿死 /
    不同 provider 同名账号互不影响 / `ttlMs=0` / 读取抛错被吞且留日志 / 并发去重 /
    空读数不记账 / 池提取口径 / 空 `packages` 兜底 / 无可用数字返回 `undefined`，
    外加一条**接线回归**（静态检查八家都真的挂了采样、gemini 带 `force`、opencode 未挂）。

11. **`scripts/credit-usage-test.mjs`**：
    - 把「同日取较大值」改名为「磁盘值 + 未落盘增量」并按新语义断言（80 + 150 = 230）；
    - 新增「两个实例并发记账互不抹掉」用例（100 + 50 = 150，且 flush 后立刻可读）；
    - 追加 **5 项账号集合用例**：跨 flush 窗口 3 账号 → `accounts=3`、同窗口多账号、
      重复 flush 幂等、老文档无 `accountIds` 兜底、两实例各见不同账号按并集；
    - 追加 **4 项跨渠道汇总用例**：老数字 + 新集合不丢下界、两侧老数据累加、
      两侧都有集合相加（真实 id 带 provider 前缀）、真实混合数据得 3；
    - 追加 **4 项真实文件后端用例**（Tester 指出假 store 证明不了 `FileUsageStore`）：
      跨 flush 窗口写入真实 `credit-usage.json` 后 accounts=3、两实例先后写盘金额相加、
      重启后历史可读、损坏文档按空账本处理并留日志。

12. **`scripts/channel-credits-ui-test.mjs`**：新增 TRAE 对照徽标的渲染断言
    （两个数字都在，且**不出现** `500-12=488` 这种相减值）。

13. **`scripts/test-all.mjs`**：接入 `credit-sampling`。

## 遗留缺陷修复（Tester 验证后追加）

### `accounts` 跨 flush 窗口退化

Tester 在独立验证中发现：同一实例 3 个账号分别在 3 个 flush 窗口记账，`spent=30`
正确但盘上 `accounts=1`（内存是 3）。

根因：`accounts` 被当成「可减的计数器」塞进差值法 —
`credit-usage-ledger.ts` 增量取 `row.accounts − previous.accounts`，后端
`mergeDocument` 对 `accounts` 取 `Math.max`：

```
窗口 1（账号 A）：内存 1，基线 0 → 送 1−0=1，盘 max(0,1)=1
窗口 2（账号 B）：内存 2，基线 1 → 送 2−1=1，盘 max(1,1)=1   ← 卡住
窗口 3（账号 C）：内存 3，基线 3 → 送 3−3=0，被当零增量跳过
```

触发条件是**常态**（一天里陆续用到第 2、3 个账号，间隔超过默认 30 秒防抖窗口），
不是边界情况。**只影响 UI「今日 N 个账号」计数，不影响金额**（Tester 实测 spent 全对）。

修法（账号数没有差值语义，改存集合并求并集）：

- `CreditUsageDay` 新增 `accountIds?: string[]`（当日见过的账号 id 集合）。
- 落盘增量只送「基线里还没有的 id」；`mergeDocument` 对集合**取并集**，
  再用并集长度重算 `accounts` —— 重复 flush / 多实例 / 重启都幂等。
- `snapshot()` 的合并也从「取较大值」改为「盘上集合 ∪ 内存集合」。
- `allSnapshot()` 跨渠道汇总同样按集合求并（无集合的老数据退回累加）。
- **向后兼容**：老文档没有 `accountIds`，`accountCountOf()` 用它的数字作历史下界
  （与并集基数取较大值，取大是保守方向，绝不把「确实用过」的账号显示丢掉）。
- 清洗层（`sanitizeCreditUsageDocument`）**保留**该字段（非字符串/空串/重复剔除），
  否则下一次读盘就把集合丢了、缺陷复现。

⚠️ 上一版本文档只写了「跨**实例**可能低估」，漏了「跨 **flush 窗口**也会低估」
这条更常见的失效路径 —— 现已在上面补全并标为已解决。

### 跨渠道汇总（`allSnapshot`）的账号数：**相加**，不是并集也不是取大

Tester 在复验时又抓到一处同口径漏网分支：`allSnapshot` 原先「只要任一侧有
`accountIds` 就只取并集长度」，于是老数据下界被覆盖。它在本机真实数据上复现：

```
raccoon 10-19: {"accounts":2, "accountIds":["raccoon-6c9bfc87"]}   ← 老数字 2、集合 1 个
buddy   10-19: {"accounts":1, "accountIds":["buddy-bfc5feec"]}
跨渠道显示 2，真值 3
```

**对账结论：Tester 建议的 `Math.max(并集长度, 两侧数字)` 也得 2，同样低于真值**
（已用脚本逐条核对）。根因是跨渠道维度上账号数**没有去重语义**：
`accountId` 是带 provider 前缀的池条目 id（`raccoon-…` / `buddy-…`），
**跨渠道永不相同**，「全部渠道共用了几个账号」的答案就是各渠道相加。

最终实现：

```ts
accounts: accountCountOf(existing) + accountCountOf(row)
```

`accountCountOf` 先在**每个渠道内部**把「老数字下界」与「集合基数」取较大值，
再加总 —— 既保住老数据下界，又符合跨渠道的真值。单渠道视图维持
`Math.max(集合基数, 老数字)` 不变（渠道内部才有去重意义），两个口径各自写死。

## 验证

| 命令 | 结果 |
|---|---|
| `node scripts/credit-sampling-test.mjs` | **12/12 通过** |
| `node scripts/credit-usage-test.mjs` | **34/34 通过**（含跨 flush 窗口、真实文件后端、4 项跨渠道汇总用例） |
| `node scripts/channel-credits-ui-test.mjs` | 通过（含新增 TRAE 对照断言） |
| `node scripts/channel-credits-rpc-test.mjs` | 通过 |
| `node scripts/raccoon-daily-grant-test.mjs` | 8/8 通过（回归） |
| `node scripts/channel-pack-test.mjs` | 通过 |
| `node scripts/channel-pack-test.mjs --source --channels-only` | 通过 |
| `node scripts/client-lint.mjs` | OK（698 键 / 176 规则） |
| `npm run channel-pack` | 成功，3.03 MiB |
| `npm run typecheck` | 通过 |
| `npm run test:contributor` | 见下方「已知基线失败」 |

## 已知基线失败

`scripts/reload-test.mjs:52` 的 `AssertionError: dependencies must belong to the new
generation` 在 `git stash` 后的干净工作区同样复现，与本次改动无关（上一任务已记录）。

## 未做 / 边界

- 未动选号器逻辑、未动签到流程（zcode 的 captcha 流程一行未改）、未改版本号 /
  签名 / 发布流程，未 `git push`。
- **采样是节流的，不是逐请求精确**：同一账号 60 秒内的多笔请求会被合并成一段差值。
  金额守恒（差值守恒），时间粒度粗。这是有意的取舍：宁可粗，不要假。
- 上游 `used` **不参与任何计算**，只做对照展示（口径不同，换算即假精度）。
- 跨进程落盘仍非原子（读与写之间有窗口），与 `token-ledger-store.ts` 同款限制，
  本次未改变，如实记录。
- 账号集合只保留当日「见过的 id」，不含昵称（昵称在明细表里，且跨重启不保留 ——
  与修复前一致，未扩大范围）。
