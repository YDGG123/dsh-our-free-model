# 合并上游 2.5.9：冲突处理记录

日期：2026-10-22　范围：`custom-main` 上的 `10480e3`（merge）、`4d20d36`（pack 重建）、
`5df57fe`（catalog 重签）、`57f9fc6`（测试样本渠道更换）

## 上游 2.5.9 做了什么（决定了我们的解法）

**渠道大清理**：

- **CodeArts 整个移除**：`codearts-credits.ts`（656 行）删除，client.js 渠道列表、
  能力矩阵、`credits.status` / `credits.balances` 分支全部不再有 codearts；
- buddy 残余删光：`buddy.ts`、`buddy-balance-rank.ts`、`retired-providers.ts` 都删了；
- 过期窗口泛化：`buddyExpiringWindowDays()` → 新模块 `credit-expiry-window.ts` 的
  `creditExpiringWindowDays()`（env 也从 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 换成
  `DSH_CREDIT_EXPIRING_WINDOW_DAYS`）；
- 另删 `direct-fetch.ts` / `llm-adapter.ts` / `models.ts` / `oauth.ts` / `login.ts` /
  `service.ts` / `sign.ts`（连带 `codeartsFetcher` 配置项一起消失）。

## 逐文件解法

| 文件 | 冲突块 | 解法 | 依据 |
|---|---|---|---|
| `scripts/channel-credits-ui-test.mjs` | 1 | claimable 吸收上游（**去掉 codearts**），保留我们的 raccoon | codearts 领取能力被上游移除；raccoon 是我们的功能 |
| `auto-checkin.ts` | 3 | 全取上游（删掉 workbuddy 残余的注释段） | 纯注释；`SCHEMA` 改名自动合并 |
| `channel-pack-rpc.ts` 块1 | 配置接口 | 只留 `creditUsage`，`codeartsFetcher` 随 codearts 退场 | 上游把该字段删了 |
| `channel-pack-rpc.ts` 块2 | codearts 状态分支 | 取上游（删除） | 渠道没了 |
| `channel-pack-rpc.ts` 块3 | codearts 余额分支 | 取上游（删除） | 渠道没了；我们的 codearts 采样随之消失（该渠道已不存在） |
| `channel-pack-rpc.ts` 块4 | TRAE 余额返回 | 保留我们的 `accounts: withCrossCheck`（上游 used 与差值对照），吸收上游的 `creditExpiringWindowDays()` 改名 | 对照是我们的功能；改名必须吸收，否则 import 指向已删除的模块 |
| `index.ts` 块1 | codearts 服务整段 | 取上游（删除，含 codearts 的发消息路径采样） | 渠道没了 |
| `index.ts` 块2 | cline 凭据解析 | **保留我们**（发消息路径节流采样） | 「八家节流采样」是我们的功能，上游只是把这段简化掉了 |
| `index.ts` 块3 | raccoon 凭据解析 | **保留我们**（`pickRaccoonAccount` 余额优先选号） | Raccoon 领取/选号是我们的功能 |
| `index.ts` 块4 | RPC 配置实参 | 去掉 `codeartsFetcher`，保留 `creditUsage` | 同块 1 |

另有索引清理：`index.ts` 里指向已删除模块的 `import { fetchCodeArtsAccountInfo }`
手动移除（自动合并留下的孤儿 import）。

## 验证

| 项 | 结果 |
|---|---|
| vendor 类型检查（差集法，`@types/node` 临时安装） | 合并后 **23** 条 = 上游 `main` 自身的 **23** 条，**零新增**（全部在 gemini/minimax/openai-gateway/channel-fetch 等上游自有文件） |
| `build-channel-pack.mjs` | 2.53 MiB（比 2.5.7 的 2.69 更小：codearts 代码删掉了） |
| `build-standalone-ui.mjs --check` | 通过 |
| `build-manifest.mjs --check` | 通过（**2.5.9**，80 文件，4,530,541 字节） |
| `test-all --mode all` | **84/84 suites**（比 2.5.7 时的 85 少 1：上游重排了套件） |
| 发现并修掉的用例问题 | 四态展示用例拿 codearts 当「无状态接口」样本 ⇒ 渠道已不存在 ⇒ `channel-credits-ui` / `channel-pack` / `channel-source` 三套件同源红；换用 lobsterai 后全绿（`57f9fc6`） |

## 用户可见影响（需要知情）

- **CodeArts 渠道在 2.5.9 里消失**（上游移除）：已有 CodeArts 账号数据随 vendor
  数据模型一起不再被引用；
- 我们的**积分账本不再采样 codearts**（渠道没了，采样点随分支删除）；
- 过期窗口的环境变量改名：`DSH_BUDDY_EXPIRING_WINDOW_DAYS` →
  `DSH_CREDIT_EXPIRING_WINDOW_DAYS`（15 天默认值不变）。

## 边界

- 未 push（本地 `custom-main` 领先远端 5 个提交，等 Chief 推送后投影 `main`）；
- 版本号跟随上游 ⇒ 2.5.9；
- 合并过程顺带处理了一件事：本地工作区曾被**插件自升级**覆盖成 2.5.8 的发布树
  （README / package-lock 被删、package.json=2.5.8），已确认内容与远端提交一致后
  还原，再快进到远端 `custom-main`（`519be56`）才开始合并。
