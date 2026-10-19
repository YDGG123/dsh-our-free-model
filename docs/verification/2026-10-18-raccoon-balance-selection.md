# Raccoon 按余额优先选号与锁定长期积分

## 背景

Raccoon（商汤小浣熊）每日 300 积分由客户端调 `GET /api/web/office/v3/setting_info`
触发、按天幂等发放，**耗尽后服务端继续扣长期积分
（奖励 / 会员 / 充值）且不报错** —— 「耗尽」是静默降级而非错误，既有的
「限流 → 换号」机制对此完全无效：手动顺序第一位的号会一直烧长期积分，
第二个号的每日额度原封不动地浪费。这与 Loomy 修过的缺陷同型
（`loomy-balance-selector.ts`，实测 2026-09-26）。

本次收尾在已写好的 `raccoon-balance-selector.ts` 与 `index.ts` 接线之上，
补齐了**上一次会话停在半路的锁定链路**：选号器导出了
`RaccoonRankOptions`（`locked` / `longTermOrder`）并写明了语义，`rank()` 却
没有实现这个参数；`PERMANENT_LOCK_PROVIDERS` 白名单已加入 `RACCOON`，
但没有任何代码读这个开关 —— 界面上会出现「锁定长期积分」按钮，锁上后
却什么都不会发生。

## 修复设计与范围

**选号器（`vendor/channel-pack/src/raccoon-balance-selector.ts`）**

- `rank(candidates, options)` 实现 `RaccoonRankOptions`：
  - `locked: true` 时**只返回每日档**（「每日积分」包 remaining > 0 的账号）。
    只剩长期积分与无余额/查不到的账号**从结果中剔除**而不是排在队尾 ——
    调用方按顺序取用，留在队尾就会被取到，锁定形同虚设（文件头档位表
    的既定语义）。查询失败的账号同样剔除：每日余额无法确认，选中它可能
    照样烧长期积分（与 Loomy 锁定态同判）。
  - `longTermOrder: 'descending'` 只重排长期档：按长期余额从多到少，
    并列回退手动顺序（「先烧小号、保住大号」的场景）；默认 `'manual'`
    保持手动拖拽顺序。每日档内永远手动顺序（每日额度人人一样多，
    按余额排没有意义）。
- 新增 `select(candidates, options)`（与 Loomy 的 `select` 同型）：返回
  带余额条目的选中结果；锁定且无每日档可用时给出
  `RaccoonNoAccountReason` —— `exhausted`（所有号都查到了、每日积分
  确实为 0）与 `unknown`（至少一个号查询失败，无法判定）必须分开，
  一次网络抖动不能被报成「额度用尽」（Loomy 2026-09-29 报障的教训）。
- 解锁态行为不变：余额全 0 仍返回第一个候选，让上游去报余额不足，
  客户端不抢先编「用尽了」。
- 缓存语义不变：成功 60 秒 / 失败 5 秒，`invalidate(id)` 供发消息路径
  在选中后立即作废该号（每日 → 长期的边界只漏一个请求的量）。

**接线（`vendor/channel-pack/src/index.ts` 的 `pickRaccoonAccount`）**

- 读 `pool.permanentLocked(RACCOON.id)`（权威在
  `$DSH_HOME/channel-pack/permanent-locks.json`，经 `credits.permanentLock`
  RPC 写入），把 `{ locked }` 传给 `select`。
- 锁定落空时**抛明确错误、绝不落到单凭据兜底** —— 兜底会绕过锁定照样
  消耗长期积分。错误文案区分两种原因（同 Loomy 约定）：
  - `unknown`：「无法确认是否有可用账号……这些账号**可能仍有**每日积分 ——
    请重试，或在 Channel Pack 的 Raccoon 面板检查凭据是否失效。」
  - `exhausted`：「没有可用账号。已锁定长期积分，而所有账号的每日积分
    都已用尽。请在 Channel Pack 的 Raccoon 面板解锁长期积分，或等待明日
    额度刷新。」
- 凭据损坏/未配置时换下一个候选（与 `pickBuddyAccount` 同语义）；若
  「有可用账号但凭据都解析不出来」，按既有行为返回 `undefined` 走适配器
  的 `MISSING_CREDENTIAL`，不误报成「积分用尽」。
- `resolveCredential` 与 `refresh` 继续共用 `pickRaccoonAccount`（refresh
  路径不作废缓存），续期的就是刚才选号挑中的那个号。
- `RaccoonBalanceSelector` 从 pack 入口导出，供离线套件注入依赖单测
  （依赖缝 `fetcher` / `now` / TTL 本就是为此设计的）。

**明确不在本次范围**

- 前端 `credits-capabilities.js` 的 `supportsPermanentLock` 列表在客户端
  包里，不在本仓库；`channel-pack-rpc.ts` 注释要求两边一致，发布桌面端
  前需同步。
- `longTermOrder` 目前只有默认 `'manual'` 接线；`'descending'` 已实现并
  被测试覆盖，留给将来的面板开关。
- manifest / catalog / release 三件套仍保持上游签名（见下）。

## 实际验证

- `node scripts/build-channel-pack.mjs`：成功（2.97 MiB；undici / jose
  依赖来自仓库 `node_modules`）。产物含 `RaccoonBalanceSelector` 与两条
  锁定错误文案。
- `node scripts/raccoon-balance-test.mjs`：**19/19 通过**。两层覆盖：
  - 选号器单测（注入 fetch / now）：解锁态分档与档内手动顺序、查询失败
    归最后、锁定只留每日档、`unknown` 与 `exhausted` 的区分、解锁态全零
    仍返回第一个候选、`longTermOrder` 两种模式、每日字段缺失按长期档、
    成功 60s / 失败 5s 缓存、`invalidate` 立即重查、凭据不可解析归最后。
  - 挂载集成（真实 pack.js + 宿主替身，每场景重新挂载以免余额缓存跨
    场景泄漏）：RPC 白名单（raccoon 可锁 / 回读，非白名单 provider 拒
    `bad-request`）；**余额优先选号**（手动第一无每日额度时改用有每日
    积分的号发请求）；锁定不拦每日档；锁定且每日全尽时报错且**不发出
    任何推理请求**；锁定且有号查不到时报「无法确认」而非「已用尽」；
    解锁后回到手动第一的号。
- `node scripts/test-all.mjs --only channel-pack`：通过（十三渠道、余额
  RPC、图片计价、匿名通道等既有检查全部保持）。
- `node scripts/test-all.mjs --only chan`：chan-relay 通过；
  channel-network 因引用已删除的 `packages/standalone/` 失败（基线遗留，
  见下）。
- `node scripts/test-all.mjs --only client-lint`：通过。
- `node scripts/test-all.mjs`（全量）：37/52。15 个失败全部与本次改动
  无关：channel-network / standalone / desktop / standalone-management /
  standalone-frontend / standalone-channels 引用上一轮瘦身删除的
  `packages/`；forward / fingerprint / free-lane-wire / recovery / registry /
  aggregate 源于上一轮宿主侧 `src/` 改动；manifest / release / catalog 需要
  与 `src/updater.js` 钉死的公钥配对的发布私钥，本副本没有（公钥未换过，
  亦无本地私钥）。与前例（docs/verification/2026-10-10-channel-proxy.md）
  同一处置：保留现有清单与签名，待维护者在发布前更新并重新签名。

## 未验证与发布边界

没有用真实 Raccoon 账号端到端跑推理（账号积分不可自由构造）；余额替身
按实测的 `GET /api/web/points/v1/balance` 信封形状（`code: 0` +
`data.available_points` / `daily_points` / 分项包）构造，档位判据以
`raccoon-credits.ts` 的解析为准。锁定开关的持久化经 RPC 路径验证；
`permanent-locks.json` 直接预置的路径在测试里同样生效（挂载时读取）。

本仓库不含前端，锁定按钮在客户端的呈现与 `supportsPermanentLock` 同步
未验证。发布前需：同步前端白名单、在具备发布私钥的环境重跑
`node scripts/build-manifest.mjs` 与 catalog revision，并处理上一轮瘦身
遗留的 15 个基线失败（另行任务）。升级无需迁移数据；回退本次改动并
重建渠道产物即可。
