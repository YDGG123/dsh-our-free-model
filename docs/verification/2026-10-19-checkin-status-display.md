# 按账号「今日领取状态」展示修复

日期：2026-10-19　范围：`vendor/channel-pack`（状态聚合与账单日期口径）、`client.js`（展示层）

## 背景与现象

用户本机 Raccoon 两个账号（`RaccoonMia (0899)` / `RaccoonAlexander (5173)`），渠道卡片上
5173 显示「今晚已领300」，0899 **什么都不显示**，于是以为 0899 没领到。

实际上早上 08:16（UTC+8）的自动签到对两个号都完成了账单核实：

```json
// auto-checkin.json
{ "provider": "raccoon", "text": "2 个 +600积分" }
// credit-usage.json（账单核实口径）
{ "day": "2026-10-19", "spent": 197, "gained": 600, "accounts": 2 }
```

⇒ **上游数据正常，问题在展示层**。并且用户进一步要求：所有支持领取的渠道、
**每个账号**都必须有明确的今日领取状态。

## 根因（三处，逐层放大）

### 1. 前端只在「已领」时渲染，其余一律静默留白

`client.js` 的账号行旧实现：

```js
credit?.todayCheckedIn === true && Number.isFinite(credit.todayCredit)
  ? badge('今日已领 {credit}')
  : null      // ← 空数组、null、查询失败，全都是这一条
```

而 `status: null` 的来源至少有四种：今天还没领、查询失败、凭据未配置、该渠道没有
状态接口。**它们在界面上是同一个空白**，用户无从判断。这正是本次困惑的直接原因。

### 2. `credits.status` 把 `null` 原样返回，不给任何原因

`collectCreditsStatus`（`channel-pack-rpc.ts`）旧实现只在异常时 `warn` 写日志，
返回的 `status` 一律是 `null` —— 前端即使想显示原因也无从取。

### 3. 前端**从不查询**没有写 `status: true` 的渠道

`loadCredits` 的守卫是 `if (!CHANNEL_CREDITS[channel.id]?.status) return`。
能力表里只有 `buddy` / `raccoon` / `minimax` 标了 `status: true`，于是
**codearts / lobsterai / trae / cline / loomy / qoder / qodercn / zcode 一次状态都不查**，
账号行永远空白。这是「部分渠道的账号没有状态」的第二层原因。

### 4. 附带发现：账单日期用字符串前 10 位比较，UTC 表述会判错

`raccoon-credits.ts` 的 `checkTodayGrantBills`：

```ts
if (createdAt.slice(0, 10) !== today) continue   // today 是 UTC+8 日键
```

只在**上游字符串本身就写着 UTC+8 日期**时成立。若上游用 UTC 表达：

| 上游写法 | 真实时刻（UTC+8） | `slice(0,10)` | 正确日键 |
|---|---|---|---|
| `2026-10-19T00:16:24+08:00` | 10-19 00:16 | 2026-10-19 ✓ | 2026-10-19 |
| `2026-10-18T16:16:24Z` | **10-19 00:16** | 2026-10-18 ✗ | 2026-10-19 |

⇒ 凌晨 00:00–08:00（UTC+8）之间的入账会被判成「昨天」，该账号当天的「今日已领」
整天显示不出来。这**同样能造成「一个号显示、一个号不显示」**（取决于各自入账时刻
落在 UTC 的哪一天），与用户报障形态一致。本次一并修正。

## 改动

### 后端

**`vendor/channel-pack/src/raccoon-credits.ts`**
- 新增导出 `billDayKey(createdAt)`：**解析成时间戳再换算 UTC+8**（复用包内
  `utc8DayKey`，不新写日期助手）。解析失败返回 `undefined`，调用方跳过 —— 不猜日期。
- `checkTodayGrantBills` 改用 `billDayKey` 比对，替换 `slice(0, 10)`。

**`vendor/channel-pack/src/types.ts`**
- `RpcCreditsAccountStatus` 新增两个可选字段：
  - `error?: string` —— 查不到时的原因；
  - `unsupported?: boolean` —— 该渠道**没有状态接口**（能力缺失，不是故障）。
- 两者分开的理由：一个值得重试/排查，一个重试无用。混成一句话会让用户白折腾。

**`vendor/channel-pack/src/channel-pack-rpc.ts`**
- `collectCreditsStatus`：`status === null` 时补 `error`
  （凭据未配置 / 上游无响应 / 异常消息），不再只写日志。
- 五个「如实返回 null」的分支（codearts / lobsterai / trae / cline / loomy）补
  `unsupported: true`。
- 新增 `CREDITS_CLAIMABLE_WITHOUT_STATUS` 白名单（lobsterai / trae / qoder /
  qodercn / zcode），`credits.status` 对它们返回
  `{ status: null, unsupported: true }`，**不再回 `bad-request`**
  （修复前 qoder / qodercn / zcode 三条会落到 `unsupported provider: …`，
  前端把它当失败吞掉）。
  ⚠️ `codearts` **不在**此表：它在 `credits.status` 里有显式分支（早于兜底分支
  执行），列进来是永远走不到的死项（Tester 观察后删除）。
- ⚠️ 未知 provider 仍回 `bad-request`：不能因为「能领取」就把拼错的 id 放过去。

### 前端 `client.js`

- `loadCredits` 守卫从「能力表有 `status`」改为「**这个渠道能领取**」
  （`capability.claim === true`）；查询失败时**保留上一次结果**，不把整块抹成空白
  （一次抖动不该让所有账号变空）。
- 新增 `claimByAccount` 状态：记下本次「一键领取」的逐账号 outcome。
  没有状态接口的渠道（codearts 等）在点过领取之后，那条 outcome 就是最准确的答案。
- 账号行状态渲染改为**四段式判定，绝不留白**。
  ⚠️ 其中「已领」分支**以 `todayCheckedIn` 为准**，`todayCredit` 只决定要不要带数字
  （Tester 观察后加固）：旧写法把两者并列，`todayCheckedIn=true` 但 `todayCredit`
  缺失时会掉到「今日未领」——**把已领说成未领**，用户会去重复点领取。真实后端当前
  不产生该形态（`todayCredit` 是必填 number，六个生产者都写了），这是防未来新渠道
  漏填的护栏。
  1. `credits.status` 有值 ⇒ `今日已领 N` / `今日未领`；
  2. 状态查不到但本次点过领取 ⇒ `刚领取 +N` / `今日已领` / `领取失败`；
  3. `unsupported` ⇒ `该渠道无状态接口`；
  4. 其余（查询失败）⇒ `状态未知（查看按钮重试）`，hover 显示具体原因。
- 新增 7 个文案键（zh + en）与 2 个样式类（`.ofm_creditbadge.none` / `.weak`），
  让「未领」「无接口」「未知」在视觉上与「已领」（绿色）区分开。

## 测试

- **`scripts/raccoon-daily-grant-test.mjs`**（8 → **11** 项）：
  - `billDayKey` 的 UTC 归一（`16:16:24Z` ⇒ 次日；`15:59:59Z` / `16:00:00Z` 跨日边界）；
  - 无法解析返回 `undefined`（不猜日期）；
  - 用 **UTC 形态**的 `created_at` 构造「今天凌晨入账」，断言 `todayCheckedIn === true`。
- **`scripts/channel-credits-ui-test.mjs`**（+5 组）：
  - `todayCheckedIn=true` 但**缺 `todayCredit`** ⇒ 显示「今日已领」（不带数字），
    且**不出现**「今日未领」；
  - 一个账号已领、另一个查询失败 ⇒ 分别显示「今日已领 300」与「状态未知」，
    且**不能**把查询失败误报成「今日未领」；
  - 同渠道「已领 + 未领」两个账号各自显示正确；
  - 无状态接口的渠道显示「该渠道无状态接口」，点过领取后改用 outcome
    （「刚领取 +1000」）；
  - 同时修掉一处**索引脆弱断言**：`unmounted.cells[4]` 写死了状态下标，本次新增
    一个 `useState` 后整体右移，断言变成一个与「卸载后不回写」无关的数字比较。
    改为按语义判定（卸载后晚到的响应不得落进 state）。
- **`scripts/channel-credits-rpc-test.mjs`**（+1 组）：可领取但无状态接口的渠道
  必须返回 `unsupported: true` 且 `ok: true`；未知 provider 仍 `bad-request`。

## 验证

| 命令 | 结果 |
|---|---|
| `node scripts/raccoon-daily-grant-test.mjs` | **11/11 通过** |
| `npm run channel-pack` | 成功，3.04 MiB |
| `node scripts/channel-pack-test.mjs` | 通过（内含 credits UI + RPC 断言） |
| `node scripts/channel-pack-test.mjs --source --channels-only` | 通过 |
| `node scripts/client-lint.mjs` | OK（705 键 / 176 规则） |
| `node scripts/raccoon-daily-grant-test.mjs` / `credit-usage` / `credit-sampling` | 通过 |
| `npm run typecheck` | 通过 |
| `npm run test:contributor` | **74/75**，唯一失败是已知基线 `reload-test` |

## 边界

- **未改动领取/签到逻辑本身**：`claimRaccoonDailyGrant`、各渠道 `claim`、
  自动签到流程一行未动；本次只动「状态聚合的容错」与「展示」。
- 已领/未领的判定口径沿用各渠道 `credits.status` 既有语义，未改判据。
- 未改版本号 / 签名 / 发布流程，未 `git push`。

## 未知与限制（如实记录）

- 本机 `fetch` 走 `channel-fetch` 的代理链，直连上游被网络策略挡住，
  故**无法在本机直连核验上游 `created_at` 的真实写法**。UTC 归一这条修的是
  「无论上游给 UTC 还是 UTC+8 都判对」，不是「确认上游用的是 UTC」。
- 无时区字符串（`2026-10-19T00:16:24`）会被 JS 按**本机时区**解析。
  在 UTC+8 机器上恰好正确，其它时区会偏 —— 这是上游不给时区时的固有限制，
  代码注释里已写明，未做假精度补偿。
- 没有状态接口的六家渠道，在用户**没点过领取**之前只能显示「该渠道无状态接口」。
  这是能力缺失，不是本次能靠展示解决的。
