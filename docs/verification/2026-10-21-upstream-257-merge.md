# 合并上游 2.5.7：冲突处理 + 云端 CI 变红的两件事

日期：2026-10-21　范围：`custom-main` 上的 `ad5f7fc`（merge）、`89f26ae`（pack 重建）、
`2956ea8`（独立端重建）、`5e198a5`（catalog 重签）、`299cfca`（测试夹具）

## 两个小时前看起来是同一件事，其实是两件

用户看到的是「今天云端同步失败，上游已升 2.5.7 但我们没跟上」。查完是**两个独立问题**：

| # | 现象 | 真因 | 与上游 2.5.7 的关系 |
|---|---|---|---|
| A | `test` workflow 的 offline job 红（run `39527065284`，`catalog-revision` 套件） | **我们自己新加的测试夹具**依赖开发机的 git 默认分支名 | 无关 |
| B | 本机 11:30 同步失败、fork 停在 2.5.6 | 上游 2.5.7 与我们的改动在 6 个文件上冲突（需人工判断） | 就是它 |

A 让 `main` 的必需检查变红，B 让版本没跟上。两件都得修，但根因完全无关。

## A. 测试夹具依赖开发机配置（真实缺陷）

云端日志：

```
FAIL 本地 HEAD 落后远端时，仍取远端值（不能信任本地）:
  Command failed: git push -q origin main:main
  error: src refspec main does not match any
```

夹具用 `git init --bare`（**没带 `-b`**）造「远端」仓库，它的 HEAD 取决于
`init.defaultBranch`：

- 这台 Mac：系统级 git 配置里就设了 `main`（实测 `git init` 后 `symbolic-ref HEAD` = `refs/heads/main`）；
- GitHub runner：没有这份配置 ⇒ `master`。

于是 clone 出来的本地分支不是 `main`，下一句 `git push origin main:main` 就
`src refspec main does not match any`。**本机永远绿、云端必然红** —— 这类夹具缺陷
只有云端能抓。

修法（`scripts/catalog-revision-test.mjs`）：

- 夹具里的 git 调用**全部**走 `gitIn()`（隔离 `GIT_CONFIG_GLOBAL` /
  `GIT_CONFIG_SYSTEM` / `GIT_CONFIG_NOSYSTEM`）；
- 分支名全部显式：bare 初始化 `-b main`、clone `-b main`、推送一律 **`HEAD:main`**
  （不去赌本地分支叫什么）。

**验证方式**（关键：必须模拟 CI，不能用本机环境）：

```bash
# 确认严格模拟下默认分支是 master，才说明模拟是忠实的
env -i HOME=/tmp/cleanhome PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 \
  sh -c 'cd /tmp/probe && git init -q . && git symbolic-ref HEAD'   # refs/heads/master

# 修好后：全绿
# 变异（还原成翻车的那三处写法）：精确复现同一条失败
```

本机常规运行也 14/14 通过。

## B. 上游 2.5.7 的冲突处理

`git merge upstream/main` 撞出 14 个冲突文件。按 SOP 分两类：

### B1. 生成产物（8 个）：取 ours + 合并后重建

`catalog/dsh-plugin.json`、`catalog/integrity.json`、`catalog/provenance.json`、
`feed/manifest.json`、`packages/standalone/web/{app.css,app.js,assets.json}`、
`vendor/channel-pack/pack.js`。重建后：

- `build-channel-pack.mjs` → 2.69 MiB
- `build-standalone-ui.mjs --check` → 一致（10 个本地资源）
- 独立端产物不在 `package.json.files` 里 ⇒ **不需要**重签 manifest（改动前已核对）

### B2. 语义冲突（6 个）：逐一判断

**上游这次的主线重构是「让 CodeBuddy / WorkBuddy 退场」**（`d187bf1`），
删掉 `buddy-adapter.ts`（2443 行）/`buddy-auth.ts`/`buddy-oauth.ts`/
`buddy-balance-selector.ts`/`product.ts`/`tencent-fingerprint.ts`，新增
`retired-providers.ts`（`provider === 'buddy' || 'workbuddy'`）。账号数据保留，
但不再能登录/探测/调用。

| 文件 | 处理 | 理由 |
|---|---|---|
| `client.js` | 接受上游删除（去掉 `buddy`/`workbuddy` 的 `CHANNEL_CREDITS` 行） | 渠道已退场，留着会渲染出「点了报错」的按钮 |
| `scripts/channel-credits-ui-test.mjs` | 同上（claimable 集合去掉两家） | 与 UI 实际能力保持一致 |
| `scripts/standalone-page-lifecycle-test.mjs` | 取 ours | 我们这边是两个桩的超集（`SponsorPage` + `SponsorNotice`） |
| `vendor/channel-pack/src/buddy-balance-selector.ts` | `git rm`（接受删除） | 上游已删；留着就要保 3500 行死代码，每次上游改动都冲突 |
| `channel-pack-rpc.ts` 块1 | `PERMANENT_LOCK_PROVIDERS` = Loomy + Raccoon（去掉两家）；保留我们的 `LONG_TERM_PREFERRED_PROVIDERS` | 锁定语义只对还能用的双池渠道有意义 |
| `channel-pack-rpc.ts` 块2 | 用上游的具名类型 `ChannelPackRpcConfig`，并把 `creditUsage` 加进该接口 | 上游把内联形参改成了类型；我们的账本字段跟着走 |
| `channel-pack-rpc.ts` 块3 | 保留我们的「可领取但没有状态接口」分支，去掉 `productById` 的 buddy 路径 | 这是用户要的「四态展示」后端；buddy 分支随产品退场 |
| `channel-pack-rpc.ts` 块4 | 取上游（余额分支直接 `bad-request`） | `productById` 已随 `product.ts` 删除 |
| `index.ts` 块1 | 只保留积分账本 + 采样器（`createCreditUsageStore` / `CreditUsageLedger` / `recordCreditUsage` / `CreditUsageSampler`），删掉 buddy 服务与 `pickBuddyCredential` | 账本是我们的功能；buddy 选号随产品退场 |
| `index.ts` 块2 | 去掉 `buddy, workbuddy` 实参，保留上游的 `codeartsFetcher` 与我们的 `creditUsage` | 两边都要 |

**用户可见影响（必须知情）**：升级到 2.5.7 后，插件里**不再有 CodeBuddy /
WorkBuddy 两个渠道**，已有账号数据保留但不可用（上游的设计决定，不是我们改的）。

## 顺手修掉一个我们自己的类型缺陷

合并后跑 `tsc -p vendor/channel-pack/tsconfig.json` 发现
`channel-pack-rpc.ts` 用了 `RaccoonProduct` **却没有 import** —— 这是**合并前就存在**
的缺陷（vendor 的类型检查从来没跑过，所以一直没暴露；esbuild 不查类型，运行也不受影响）。
已补 `import type { RaccoonProduct } from './raccoon-product.js'`。

## 验证

### 类型检查（差集法，确认合并没引入新错误）

`vendor/channel-pack` 有 tsconfig 但没装 `@types/node`（临时 `npm i --no-save` 装上，
验证完已移除；lockfile 未被改写）：

| 版本 | 错误数 |
|---|---|
| 合并前 HEAD（`3f11170`） | **37** |
| 合并后 | **21** |

合并后的错误集合是合并前的**子集**（`comm -13` 为空）⇒ **合并没有引入任何新错误**，
反而少了 16 个。剩下 21 个都在上游自有文件里（`openai-gateway/*`、`gemini-*`、
`minimax-*`、`channel-fetch`），属既有类型债，**本轮不动**（见「未做」）。

### 端到端

| 项 | 结果 |
|---|---|
| `test-all --mode all`（与 main 上的 `test` workflow 同口径） | **85/85 suites** |
| `test-all --mode release` | **3/3**（`catalog` 通过） |
| `build-manifest --check` | 通过（2.5.7，80 文件，4,703,421 字节） |
| `host-selftest` | 通过 |
| 构建产物对 `@types/node` 的敏感性 | **无**（有无该依赖，重建都逐字节一致） |

fork 定制项核对：`src/updater.js` 的 `REPO`、`PINNED_MANIFEST_PUBLIC_KEY` 完好；
四个功能 commit（`0442e4e` / `0173801` / `dca8d2a` / `1fabee3`）仍在历史里；
`credit-usage-*`、`raccoon-balance-selector`、`long-term-preferred-store` 均在。

## 未做（明确留给后续）

1. **vendor 的 21 个既有类型错误**：都在上游自有文件里，修它们要动 gemini/minimax/
   openai-gateway 的消息类型，与本轮目标无关。建议单独派任务，并考虑给 vendor
   加一条「错误数不得增加」的棘轮（否则这类债只会继续长）。
2. **「每次 push 都带 secret 打外部 webhook」**：`EBONY_WEBHOOK_SECRET` 在本仓库的
   **任何提交里都不存在**（`git log --all -S` 为空），仓库 secrets 也只有三个
   （`OFM_RELEASE_PUSH_TOKEN` / `RELEASE_SIGNING_KEY` / `RELEASE_MANIFEST_PRIVATE_KEY`），
   上游 2.5.7 的 workflow 列表里也没有订阅通知类 workflow。**需要问清在哪里看到的**
   之后再改，不能凭猜删东西。

## 边界

- 未 push（`custom-main` 本地领先远端 5 个提交）；`main`（发布分支）仍是 2.5.6。
- 版本号跟随上游 ⇒ 现在是 2.5.7，不是我们改的。
- 未改 `catalog-test.mjs` 的独立口径，未动 `release-sign.yml`。
