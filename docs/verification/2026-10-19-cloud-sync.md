# 上游同步托管到云端（GitHub Actions）

日期：2026-10-19　范围：`.github/workflows/sync-upstream.yml`、`scripts/sync-upstream.mjs`、
`scripts/report-sync-failure.mjs`、`scripts/check-sync-failure.mjs`

## 为什么

原来的同步靠本机 launchd（`com.ydgg.ofm-sync-upstream`，每日 11:30）。
它的前提是 **Mac 开机且已登录**：关机、睡眠、登出都会跳过，而且 launchd
**不会补跑**。用户要求「Mac 不开机也能跑」，故托管到 GitHub Actions。

## 架构

```
┌─────────────── GitHub Actions（云端，Mac 开不开机都能跑）───────────────┐
│                                                                        │
│  schedule 03:17 UTC (= 11:17 CST)      workflow_dispatch（手动）        │
│              │                                      │                  │
│              └──────────────┬───────────────────────┘                  │
│                             ▼                                          │
│              node scripts/sync-upstream.mjs --ci                       │
│                             │                                          │
│        fetch upstream ── merge ── 重建 pack.js ── 刷新 revision         │
│                             │                     ── 重签（有密钥时）    │
│                             │                     ── 跑测试集           │
│                             ▼                                          │
│                    ┌────────┴────────┐                                 │
│                 成功 │                 │ 失败                            │
│                    ▼                 ▼                                 │
│           git push origin main   写 .private/sync-failure.json         │
│                    │             → fork 的 sync-failure 分支            │
│                    ▼                 │                                 │
│      release-sign.yml 自动重签        │                                 │
│      （上游既有 workflow）            │                                 │
└──────────────────────────────────────┼─────────────────────────────────┘
                                       │  (raw.githubusercontent.com)
┌──────────────────────────────────────┼─────────────────────────────────┐
│ 本机 launchd（每日 11:40）            ▼                                 │
│  node scripts/check-sync-failure.mjs ── 有新的失败 ── osascript 通知     │
│                                       └ 已通知过 ── 跳过（指纹去重）     │
└────────────────────────────────────────────────────────────────────────┘
```

### 为什么失败通知走「状态文件」而不是回调

用户选择的方案。它单向、无回调、凭据最少暴露：

- 云端只需要**写**一个文件（repo 写权限）；
- 本机只需要**读**（公开仓库连 token 都不用）；
- 本机不用对外暴露端口或 webhook，也不用让云端持有任何能触发本机动作的东西。

## 与 `release-sign.yml` 的分工（不要重复造签名）

`main` 上已有上游的 `release-sign.yml`：任何 push 到 main 之后，它会自己判断
清单与树的漂移、重建重签、跑 `refresh-revision.mjs`，再推回来。

所以本 workflow **只负责合并 + 回归 + 推送**：

- 配了 `RELEASE_SIGNING_KEY` ⇒ 同步脚本自己也会签一次（推上去当场自洽）；
- 没配 ⇒ 脚本**跳过重签**（不硬失败），由 `release-sign.yml` 补齐。

## 复用而非复制

云端与本地**共用同一份 `scripts/sync-upstream.mjs`**，靠 `--ci` 切换三处差异：

| 方面 | 本地 | `--ci` |
|---|---|---|
| 推送方式 | `api-push-squash.mjs`（本机 git 传输到 github 被阻断，走 REST API 逐 blob） | 常规 `git push` |
| 推送目标 | 远端 `main`（内容 squash 成单提交，完整历史留在 `custom-main`） | **同样 `main`** —— 保持发布语义一致 |
| 签名密钥 | `.private/ofm-release-key.pem` | `OFM_RELEASE_KEY` 指向 runner 临时文件 |
| 状态游标 | `.private/upstream-sync-state.json` | 不需要（每次全新 checkout，靠 `merge-base` 判断） |
| 失败 | 回滚本地 | 回滚 + 写状态文件（`--fail-file`） |

⚠️ **为什么不推 `custom-main`**：`main` 才是发布分支，是所有安装者的升级源；
本机推送语义就是「把 custom-main 的内容压成一个提交推到 main」。云端沿用同一
目标，避免出现两套发布历史。

## 时间安排与并发

- 云端：**03:17 UTC = 11:17 CST**，刻意**错开本机 11:30** 13 分钟。
  两者都动同一个远端分支，撞在一起时后者必然 non-fast-forward 失败。
- `concurrency: group: sync-upstream, cancel-in-progress: false` —— 不并发、
  也不半途取消（取消可能留下中间状态，虽然脚本会回滚，但排队更可预测）。

## 需要配置的 GitHub Secrets

到 fork 仓库 → Settings → Secrets and variables → Actions → New repository secret：

| 名称 | 值 | 用途 |
|---|---|---|
| `OFM_RELEASE_PUSH_TOKEN` | 有 repo 写权限的 PAT（与 `.private/gh-token` 里那个相同即可） | 推 main、写 sync-failure 分支 |
| `RELEASE_SIGNING_KEY` | `.private/ofm-release-key.pem` 的**完整内容**（含 BEGIN/END 行） | 合并后重签清单；不配也能跑，由 release-sign.yml 补签 |

```bash
# 读私钥内容（复制输出，别贴进聊天/issue）
cat .private/ofm-release-key.pem
```

⚠️ 这两个 secret 只在该 fork 的仓库里；**不要**提交任何密钥到仓库。

## 本机通知桥（需要一次 plist 改动）

脚本：`scripts/check-sync-failure.mjs`

```bash
node scripts/check-sync-failure.mjs            # 检查并弹通知
node scripts/check-sync-failure.mjs --dry-run   # 只打印将要通知什么
node scripts/check-sync-failure.mjs --force     # 忽略去重，无条件弹一次
```

**去重**：状态文件每次失败都被覆写，本机记下「已通知指纹」
（`failedAt` + `failedStep` + 冲突文件数；**不含** `runUrl` —— 后者每次重跑都变，
放进指纹会导致同一条失败反复弹）。记在 `.private/sync-notify-state.json`。

### plist 需要加的内容

在 `~/Library/LaunchAgents/com.ydgg.ofm-sync-upstream.plist` **另加一个**任务
（不要覆盖原有那个），每天 11:40 跑（本机 11:30 那轮结束后）：

```xml
<key>ProgramArguments</key>
<array>
  <string>/Users/yidagege/Documents/trae_projects/.tools/node24/bin/node</string>
  <string>/Volumes/办公/IDM下载/Our Free Model/dsh-our-free-model/scripts/check-sync-failure.mjs</string>
</array>
<key>WorkingDirectory</key>
<string>/Volumes/办公/IDM下载/Our Free Model/dsh-our-free-model</string>
<key>StartCalendarInterval</key>
<dict>
  <key>Hour</key>
  <integer>11</integer>
  <key>Minute</key>
  <integer>40</integer>
</dict>
<key>StandardOutPath</key>
<string>/Volumes/办公/IDM下载/Our Free Model/dsh-our-free-model/.private/notify.log</string>
<key>StandardErrorPath</key>
<string>/Volumes/办公/IDM下载/Our Free Model/dsh-our-free-model/.private/notify.log</string>
```

Label 建议 `com.ydgg.ofm-check-sync-failure`，装好 `launchctl load` 即可。
（plist 由 Chief 执行，本任务只产出脚本与这段配置。）

## 失败处理 SOP

云端失败时 Actions 会红，`sync-failure` 分支有 `.private/sync-failure.json`：

```json
{
  "failedAt": "2026-10-19T03:17:00Z",
  "failedStep": "merge-conflict",
  "message": "…",
  "upstreamHead": "…",
  "preMergeHead": "…",
  "conflictedFiles": ["client.js", "vendor/channel-pack/src/index.ts"],
  "runUrl": "https://github.com/…/actions/runs/…"
}
```

1. 看 `runUrl` 的日志，确认是哪一步（`failedStep`：`merge-conflict` /
   `test-failed` / `sign-failed` / `build-failed` / `push-failed`）
2. 云端**不会**在失败时推送任何东西（脚本会 `reset --hard` 回合并前），
   所以远端始终是上一个好状态 —— 不需要紧急回滚
3. 按 `docs/verification/2026-10-19-upstream-sync.md` 的「冲突处理 SOP」在**本机**
   手动解（本机有完整历史、编辑器、可反复跑测试）
4. 解完在本机 `git push`（或跑 `node scripts/sync-upstream.mjs --push`）

## 回滚

| 想停掉什么 | 做法 |
|---|---|
| 云端定时同步 | 删掉 `.github/workflows/sync-upstream.yml`（或注释 `schedule:`） |
| 本机通知 | `launchctl unload ~/Library/LaunchAgents/com.ydgg.ofm-check-sync-failure.plist` |
| 误推的 main | `git revert -m 1 <merge-sha>`（**不要** reset，会改写别人的历史） |
| 清掉失败记录 | 删掉 fork 上的 `sync-failure` 分支（下次失败会重建） |

## 测试

`scripts/cloud-sync-test.mjs`（**17 项**，已接入 `test-all`）：

- **写**：首次写不带 `sha`、重复写必须带 `sha`（否则 API 422）、失败时如实返回状态码
- **载荷归一化**：缺字段补齐（通知里不能出现 `undefined`）、脏字段剔除
- **读**：404 视为「无失败」（正常态）；5xx 抛错（不能当成没有失败）
- **去重指纹**：同一次失败重跑（`runUrl` 变化）指纹不变；时间/步骤/冲突数任一变化才变
- **通知文案**：冲突类列文件名（超三个截断）、测试失败用 message 摘要
- **osascript 转义**：文件名含引号不会提前闭合脚本、引号成对
- **非 macOS / osascript 失败**：退化为日志，不让检查流程变红
- **直接执行守卫**：本仓库路径含空格，必须用 `pathToFileURL` 而不是手工拼
  `file://`（真实缺陷：手工拼永不相等 ⇒ 脚本静默空过）

另外做了**本地端到端模拟**（本地 HTTP 服务器扮演 fork）：写入 → 读出 →
去重 → 通知文案，全链路通过。

## 验证

| 项 | 结果 |
|---|---|
| workflow YAML 解析（js-yaml） | 通过，8 个 step，触发 `schedule` + `workflow_dispatch` |
| `node scripts/cloud-sync-test.mjs` | **17/17 通过** |
| `node scripts/sync-upstream.mjs --ci` | 通过（上游无新提交 → 安全退出） |
| `npm run test:contributor` | **73/74**，唯一失败是已知基线 `reload-test` |
| `npm test`（release 模式） | **75/76**，同样只剩该基线 |
| `typecheck` / `channel-pack-test` / `client-lint` | 通过 |

⚠️ **本 workflow 未启用、未触发**：没有 Secrets 时跑必然失败。用户配好两个
Secret 后，到 Actions 页面手动 `Run workflow` 做首次演练（建议先用
`dry_run: true`，它只合并 + 回归、不推送）。

## 边界

- 未 push、未改版本号、未动 plist。
- 云端跑的是**同一份**同步脚本：合并策略、生成产物取 ours、重建、测试集
  与本地完全一致，不存在两套逻辑。
