# Raccoon 每日积分领取

## 背景与根因

上游误以为 Raccoon 每日 300 积分由服务端自动发放，所以
`vendor/channel-pack/src/channel-pack-rpc.ts` 的 `credits.claimAll` 里对
RACCOON 直接返回「不支持每日签到」。

真相（已被用户另一项目 agent2api 的 Rust 实现验证过）：

- 官方桌面客户端每次启动会调
  `GET {apiBase}/api/web/office/v3/setting_info`，**这就是每日积分的发放触发器**。
- 服务端按天幂等；响应里的 `point_grant_popups` / `point_grant_toast` 是发放通知，
  只原样透出、不深入解析。
- 权威结果靠账单核对：`GET {apiBase}/api/web/points/v1/bills?paging.limit=20&paging.offset=0`，
  筛 `points > 0` 且 `created_at` 日期 == 今天（**UTC+8**，复用包内现成的
  `utc8DayKey`）。
- 账单接口实测很慢（约 9 秒），使用独立放大的超时 25 秒。

## 改动文件

1. `vendor/channel-pack/src/raccoon-credits.ts`
   - 新增 `claimRaccoonDailyGrant(product, credential, fetcher)`：先查账单——今天已有入账则报
     `already-claimed` 且**不再打触发器**；否则打 `setting_info`，再查账单核实——有入账报
     `claimed`（credit 为今日入账合计），无入账如实报失败「未能确认今日入账」。
   - 新增 `fetchRaccoonDailyGrantStatus(product, credential, fetcher)`：账单口径的今日领取状态，
     供 `credits.status` 使用。
   - 账单核对接口使用独立 25 秒超时；`checkTodayGrantBills` 失败时返回 `null`，
     不返回带 `granted:0` 的对象，避免调用方误判。
   - 模块头注释更新，明确「每日积分不是服务端无条件自动发放」。

2. `vendor/channel-pack/src/raccoon-auth.ts`
   - `RaccoonAuth` 新增 `claimDailyGrant(credential)` 与 `fetchDailyGrantStatus(credential)`，
     与 Loomy 的 `claimDailyQuota` 写法对照。

3. `vendor/channel-pack/src/channel-pack-rpc.ts`
   - `credits.status` 的 RACCOON 分支接入 `raccoon.fetchDailyGrantStatus`。
   - `credits.claimAll` 的 RACCOON 分支从 bad-request 换成真实领取：
     使用 `collectClaimResults` 逐账号顺序执行、单账号失败不中断，用 `computeClaimSummary` 汇总。

4. `client.js`
   - `CHANNEL_CREDITS.raccoon` 改为 `{ claim: true, status: true, lock: true, preferred: true }`。

5. `vendor/channel-pack/src/auto-checkin.ts`
   - 更新把 raccoon 列为「不支持每日签到」的过时注释。
   - 确认 `isAutoCheckinExcluded` 仍只含 `zcode`，不含 raccoon（raccoon 没有 zcode 那种
     captcha 代价），因此每日自动签到自然覆盖它。

6. `scripts/raccoon-daily-grant-test.mjs`（新增）
   - 离线单测覆盖：首次领取成功、今日已领不再打触发器、触发器失败如实报失败、
     账单核对失败如实报、UTC+8 边界、status 有/无入账、status 账单失败返回 null。

7. `vendor/channel-pack/pack.js`
   - 重新构建，产物包含上述改动。

## 验证

- `node scripts/raccoon-daily-grant-test.mjs`：**8/8 通过**。
- `npm run channel-pack`：成功，产物 3.02 MiB。
- `node scripts/channel-pack-test.mjs --source --channels-only`：通过。
- `node scripts/channel-credits-ui-test.mjs`：通过。
- `npm run typecheck`：通过。
- `npm run test:contributor`：**72/73 suites 通过**；唯一失败的是 `reload-test`，
  在干净工作区（`git stash` 后）同样复现，与本次改动无关。

## 发布边界

- 未改动选号器、未改动其他渠道、未改版本号 / 签名 / 发布流程，未 `git push`。
- 自动签到排除表不含 raccoon，每日首次启动自动签到会覆盖该渠道。
