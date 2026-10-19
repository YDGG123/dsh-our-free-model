# 上游同步机制（fork 维护）

日期：2026-10-19　范围：`scripts/sync-upstream.mjs`、`docs/FORK.md` 相关

## 背景与需求

用户对 fork 的要求原话：

> 原项目现在应该更新了，我需要做到原项目更新后能够自动把我们改过的功能合并进去，
> 这样原项目的更新我们能用到，我们自己改的功能也能用到。

即：**持续跟随上游，同时不丢本 fork 的定制**。

## 关键约束（决定了策略选择）

### 1. 用 merge，不用 rebase

`rebash` 会重写本 fork 的提交，hash 全变 —— 已推送到 `origin` 的历史会被改写，
其他克隆的人下次 pull 会冲突。**merge 保 hash 不变**，代价只是历史上多一个
merge commit。本 fork 的四个功能 commit（`0442e4e` / `0173801` / `dca8d2a` /
`1fabee3`）必须继续以原 hash 存在。

### 2. 两处 fork 定制**绝不能**被上游覆盖

| 位置 | 必须是本 fork 的值 | 被覆盖的后果 |
|---|---|---|
| `src/updater.js` 的 `REPO` | `YDGG123/dsh-our-free-model` | 升级会把**上游版本**装进来，整体覆盖本 fork 的自有功能 |
| `src/updater.js` 的 `PINNED_MANIFEST_PUBLIC_KEY` | 本 fork 公钥 | 用上游公钥必然验签失败，升级路径一直报错 |

这两处是**成对**的，改一个不改另一个会让升级静默失效。详见 `docs/FORK.md`。
好消息：上游几乎不动这个文件，首次同步演练中它**自动合并成功、无需人工干预**。

### 3. 生成产物冲突 ≠ 真冲突

`catalog/*.json`、`feed/manifest.json`、`vendor/channel-pack/pack.js` 的冲突
每天都会出现（两边都动了版本/签名/构建产物），但它们**完全由源码决定** ——
取哪边都会被随后的「重建 + 重签」重写。故脚本对这类冲突自动取 ours 并重建。

反过来：**源码冲突必须人工处理**。脚本遇到就 abort，不瞎解。

### 4. 版本号跟随上游

上游升版本（如 2.5.2 → 2.5.4），`package.json` 就跟随上游。我们不改版本号。

### 5. 默认**不推送**（本次修正）

旧脚本无条件把合并结果 push 到 `origin`。这有两个问题：

- 「同步上游」是本地仓库维护，跑完看回归结果就该结束；「发布我的 fork」会改变
  所有安装者的升级源 —— 两件事不该绑死；
- 推上去之后就没有「先看看合并结果」的机会了。

现在推送必须显式 `--push`。**⚠️ launchd 的定时任务（`com.ydgg.ofm-sync-upstream`，
每日 11:30）原本依赖无条件推送**，若要保留自动发布语义，需要在 plist 的
`ProgramArguments` 里显式加上 `--push`。本次**没有**改用户的定时任务配置。

## 流程

```
git fetch upstream
      │
      ├── 上游已在本地历史中 → 更新游标，退出（幂等，可反复跑）
      │
      ├── 工作区不干净 → 退出（绝不覆盖未提交改动）
      │
      └── git merge --no-ff upstream/main
                 │
                 ├── 有源码冲突 → merge --abort，列出冲突文件，退出码 1
                 │                 （留给人处理，见下方 SOP）
                 │
                 ├── 只有生成产物冲突 → 逐个 checkout --ours → commit
                 │
                 └── 合并成功
                          │
                          ├── 重建 pack.js（上游动 vendor 源码时旧产物必然过期）
                          ├── catalog 版本/修订号跟随 package.json → 重签 manifest
                          ├── 刷新 catalog revision + 重签（merge 动了发布内容时）
                          ├── 跑目标测试集（失败则 reset 回合并前）
                          │   ⚠️ 含 catalog-test；用 release 语义校验 revision
                          └── ┬ 默认：不推送，报本地 HEAD
                             └ --push：推送到 origin
```

## 冲突处理 SOP（源码冲突时）

脚本会 abort 并打印冲突文件清单。手工步骤如下：

```bash
# 1. 重新发起合并（脚本已 abort，工作区是干净的）
git merge --no-ff upstream/main

# 2. 看冲突
git status --short | grep '^UU'
git diff --diff-filter=U        # 逐块看两边改了什么

# 3. 按「两边改动都保留」的原则编辑。判断依据：
#    git log --oneline -5 <我们的 branch> -- <file>   # 我们改它的理由
#    git log --oneline -5 upstream/main -- <file>     # 上游改它的理由

# 4. 标记已解决
git add <file>

# 5. 全部解决后：重建 + 回归（**必做**，冲突解决得对不对比语法错误难发现）
npm run channel-pack
npm run typecheck
npm test                      # ⚠️ 用 **release 模式**，别只用 contributor（见下）
npm run test:contributor      # 已知基线：reload-test 失败，与合并不相关

# 6. 提交
git commit
```

### 典型案例（本 fork 实际改过的文件）

**`client.js`** —— 我们加了「四态领取状态」和「TRAE 上游 used 对照」，
上游可能改同一块渲染逻辑。原则：

- 我们的**语义**必须保留：每个账号都要有明确状态（已领 N / 今日未领 /
  无状态接口 / 状态未知），绝不留白；TRAE 的 `upstreamUsed` 与
  `recordedSpent` **只并排不相减**。
- 上游的**新结构**要吸收（例如它换了组件拆分方式），把我们的判定逻辑
  移植到新结构里，而不是整块保留旧代码。
- 文案键必须成对存在于 zh/en 两个字典（`client-lint` 会查）。

**`vendor/channel-pack/src/channel-pack-rpc.ts`** —— 我们改了 `credits.status`
的三个地方（补 `error` 原因、五个 `unsupported: true` 分支、
`CREDITS_CLAIMABLE_WITHOUT_STATUS` 白名单）。原则：

- 这三处是**一套**：只保留其中一处会让状态展示退化（例如有白名单但没
  `unsupported` 标记，前端仍显示「状态未知」而不是「该渠道无状态接口」）。
- 未知 provider 仍必须回 `bad-request` —— 不能因为「能领取」就把拼错的
  provider id 放过去。

**`vendor/channel-pack/src/index.ts`** —— 我们给 8 家渠道的
`resolveCredential` 插了 `creditSampler.sample(...)`。上游若重构某家的
`resolveCredential`，**必须把那一行移植过去**，否则该渠道退回「只有开面板
才记账」（这正是用户报障「少记 10 倍」的根因）。可以用
`scripts/credit-sampling-test.mjs` 的接线回归检查兜住：它静态断言八家都
挂了采样、gemini 带 `force`、opencode 未挂。

**`scripts/test-all.mjs`** —— 我们加了 `credit-sampling` 套件、移除了三个
永不能独立执行的假绿灯条目。上游若整段重排套件表，把这些改动带过去，
别让假绿灯条目回来。

## ⚠️ merge 动了发布内容 ⇒ 必须刷新发布清单 revision（release 模式是门禁）

**真实缺陷（2026-10-19 首次同步演练被 Tester 抓到）**：merge commit `524f972`
改动了发布内容（`client.js`、`vendor/channel-pack/pack.js`、`package.json` 等），
但 `catalog/dsh-plugin.json` 的 `source.revision` 与
`catalog/provenance.json` 的 `subject.sourceRevision` 仍指向 merge 前的
`dca8d2a`。重建重签只保证**字节**一致，**不**刷新这个指针。

- **contributor 模式会跳过这条检查**（只打印一行 `pending release: …`）⇒
  只跑 `npm run test:contributor` 会得到一片绿，把问题掩盖掉。
- **release 模式（`npm test`）是门禁**：

  ```text
  FAIL source revision is the last commit that touched the release content
       got "dca8d2a…", want "524f972…"
  ```

### 为什么不会「永远追不上自己」

`contentRevision` 的定义是「**最后一次触碰发布内容**的提交」，发布内容 =
`package.json` 的 `files` 列表里的路径（**不含** `catalog/` 与 `feed/`）。
刷新提交只改 `catalog/`，所以它不会移动这个指针 —— 刷新完指针依然成立。
仓库既有提交（`catalog: sign the release over <sha>`）正是这个形态，照做即可。

### 刷新步骤

```bash
# 1. 算 contentRevision（与 catalog-test 完全同一算法）
REV=$(git log -1 --format=%H -- package.json $(node -p "require('./package.json').files.join(' ')"))

# 2. 写进两处（注意 dsh-plugin.json 有**两个** version）
#    catalog/dsh-plugin.json : version + source.version + source.revision
#    catalog/provenance.json : subject.version + subject.sourceRevision

# 3. 重签
node scripts/build-manifest.mjs --key .private/ofm-release-key.pem

# 4. 验证（必须 release 模式）
node scripts/catalog-test.mjs     # 期望 exit 0
npm test

# 5. 提交（只含 catalog/ 与 feed/，信息写清刷新到哪个 sha）
git add catalog feed && git commit -m "catalog: refresh release revision over <sha>"
```

⚠️ **顺序很重要**：先刷新 + 重签 + **验证通过**，再提交。提交本身不会移动
指针，所以不需要再来一轮。

## 回滚

| 想撤销什么 | 命令 |
|---|---|
| 合并做到一半（脚本已 abort，一般不需要） | `git merge --abort` |
| 已提交的 merge commit | `git reset --hard HEAD~1`（**只在本机、未推送时**） |
| 已推送的 merge | `git revert -m 1 <merge-sha>`（不要 reset，会改写别人的历史） |
| 脚本跑到一半失败 | 脚本自己 `reset --hard <合并前 HEAD>`；远端未动 |

⚠️ `git reset --hard` 会**丢弃未提交改动**。执行前先 `git status` 确认，
或 `git stash push -u`。

## 首次同步演练（2026-10-19 实际执行）

- 上游领先 **16 个提交**（v2.5.3 修复 + v2.5.4：赞助公告、桌面端与插件 UI 优化）
- **源码零冲突**：`client.js`、`vendor/channel-pack/src/**`、`scripts/test-all.mjs`
  等全部自动合并成功 —— 我们的四轮改动与上游改动落在不同区域
- 冲突只有 4 个生成产物：`catalog/dsh-plugin.json`、`catalog/integrity.json`、
  `catalog/provenance.json`、`feed/manifest.json` → 取 ours 后重建重签
- 合并后**必须**跟随的两处（都是这次踩出来的）：
  1. **catalog 有两个 `version`**：顶层 `version` 与 `source.version`。
     旧脚本只更新后者 ⇒ `catalog-test` 报
     `version tracks package.json — got "2.5.2", want "2.5.4"`。**已修脚本**。
  2. **`standalone-page-lifecycle-test.mjs` 的测试桩**：上游 2.5.4 在
     `app.tsx` 新引了 `SponsorPage` / `SponsorNotice`。该套件用 vm 跑**真实的**
     `app.tsx`，桩里缺符号会抛 `ReferenceError: SponsorNotice is not defined`
     —— 看起来像页面坏了，实际只是测试桩没跟上上游新增导入。**已补桩**，
     并把该套件加进同步脚本的测试集。
- 结果：`test:contributor` **72/73**，唯一失败是已知基线 `reload-test`
- merge commit：`524f972`

## 现状与后续建议

- 同步脚本现已幂等：反复跑只会在「上游已在历史中」时更新游标退出。
- 定时任务已加载（`~/.Library/LaunchAgents/com.ydgg.ofm-sync-upstream.plist`，
  每日 11:30）。**因为本次把推送改成需要 `--push`，定时任务现在只会同步 +
  回归、不推送**。想让定时任务继续自动发布，需自行在 plist 的
  `ProgramArguments` 里加 `--push`。
- 若将来出现**源码冲突**，脚本会 abort 并留待人工 —— 这是刻意的：自动合并
  只能承诺「无冲突」这一种情况，真冲突需要人判断语义。
