# revision 口径固化：唯一正确值 = 远端分支上「发布内容的最后触碰提交」

日期：2026-10-20　范围：`scripts/lib/catalog-revision.mjs`（新增）、
`scripts/sync-upstream.mjs`、`scripts/api-push-squash.mjs`、
`scripts/catalog-revision-test.mjs`（新增）、`scripts/test-all.mjs`

## 为什么要有这一轮

前两轮修的是**调用点**，不是**口径本身**，于是同一个 bug 换了个位置又长出来：

| 时间 | 谁在算 | 写进 catalog 的值 | 结果 |
|---|---|---|---|
| 10-19 | 本地 HEAD | 本地 sha | 远端**不存在**这个提交（API 404）⇒ `got "524f972", want "82904ed"` |
| 10-20 | 推送后的 HEAD | `b005cb2` | 那个提交只碰了 `catalog/`，真正碰发布内容的是 `c85e27e` |
| 10-20 | 推送前的 sha | 同上 | 只是换了时机，同样不对 |

三次都是「值算在一个**错误的 git 对象**上」。所以收尾不只是修一处，而是把
**算法收进一个模块**，让所有推送通道共用，并把「在哪个对象上算」写死成
**远端分支**。

## 明文规则（这段就是判据）

> **catalog 的 `source.revision` / `subject.sourceRevision` 必须等于
> 「发布内容的最后触碰提交」**，而发布内容 = `package.json` + 它的 `files` 列表。
>
> - 内容提交的 sha **不是** revision。squash 投影出来的那一个提交，只有在它
>   确实改了发布内容时才是答案。
> - 本地 `HEAD` **不是** revision。它可能是刷新 catalog 的提交（只碰 `catalog/`）。
> - 推送前/推送后的 sha **都不是** revision。前者在远端不存在，后者会过期。
> - **唯一正确值 = 在远端分支上跑 `git log -1 -- <发布内容>`。**
>
> 计算式（`package.json` 的 `files` 由文件本身提供，绝不手写第二份清单）：
>
> ```
> git log -1 --format=%H -- package.json <pkg.files...>
> ```
>
> 该值只统计发布内容、**不含** `catalog/` 与 `feed/`，所以「把 revision 写进
> catalog 的那个提交」不会移动这个指针 —— 刷新是幂等的，不会无限追自己。

## 实现

### 唯一实现：`scripts/lib/catalog-revision.mjs`

| 导出 | 用途 |
|---|---|
| `releaseContentPaths(pkg)` / `readReleaseContentPaths()` | 发布内容清单（来自 `package.json`，不手写） |
| `contentRevisionAt(ref)` | 在**任意 ref** 上求「最后触碰提交」（`catalog-test` 的同一条 git log） |
| `fetchRemoteBranch(branch)` | 把远端分支抓成 `refs/remotes/<remote>/<branch>`（显式 refspec，不靠 fetch 配置） |
| `remoteContentRevision(branch)` | fetch + 重算 = **写进 catalog 的唯一正确值** |
| `catalogRevision()` | 读本地 catalog 现值（仅用于推送后自证） |
| `isReleaseContentPath()` | 判断某路径是否属于发布内容 |

`fetchRemoteBranch` 带重试：本机到 `github.com:443` 的 git 传输是**间歇性**
可用的（实测同一分钟内 HTTP2 framing 错误与成功交替，单次失败要等 75 秒），
一次失败就整条降级代价太大。

### 两个调用点

**`sync-upstream.mjs`（云端 `--ci`）**：

```
推 custom-main → fetch 远端，在 origin/custom-main 上重算 → 写 catalog
  → 推刷新提交 → 自证（catalog 值 == 远端重算值）
  → 投影 main → 再在 origin/main 上重算并比对
```

刷新提交只碰 `catalog/`/`feed/`，所以自证时远端重算值不变 —— 这条自证本身
就是「写对了」的证明。

**`api-push-squash.mjs`（本机 API 通道）**：

```
读推送前远端 catalog 基线 → 推内容（记录是否碰了发布内容）
  → 判 revision（远端重算优先，拿不到走降级判据）→ 写 catalog → 推第二段 → 自证
```

## ⚠️ 本机降级路径：两个必须记住的坑

本机走 API 通道的**原因**就是 git 传输被阻断，所以不能假定 `fetch` 可用。
降级判据是：

- 这次推送**碰了发布内容** ⇒ revision = 刚推上去的那个 squash 提交（它确实是
  「最后触碰发布内容的提交」）；
- 这次推送**没碰发布内容** ⇒ revision = **推送前**读到的远端 catalog 现值；
- 两者都拿不到 ⇒ **报错**，绝不猜。

**坑 1：基线必须在推送前读。** 第一版在写完 catalog 之后才去读远端现值，
但那时远端已经是我们刚推上去的内容 —— 「保持现值」变成「把过期值原样写回去」，
等于什么都没修。（自查时发现，`api-push-test` 有断言守住顺序。）

**坑 2：传输不可用只判定一次。** 单次失败要等 75 秒，而 revision 判定与
推送后自证会各试一次 —— 两次 75 秒纯属浪费，还会拖长 launchd 定时任务。
用模块级 `gitTransportUnavailable` 记忆，第一次失败后直接走降级。

## 测试

新增套件 `scripts/catalog-revision-test.mjs`（**14 项**），用**真实临时 git
仓库**验证算法，而不是正则断源码 —— 后者只能证明「写了什么」，证明不了「算得对」：

- 发布内容之外的提交（README / catalog）不移动 revision；
- 改了 `package.json` 的 `files` 后判据随之变化（证明没有第二份清单）；
- 远端重算：本地 HEAD 落后/超前时仍取**远端**值（真实事故现场）；
- **推送后远端 HEAD 又前进（只碰 catalog）⇒ revision 不变**（防无限追自己）；
- fetch 失败 / 无 `package.json` / 发布内容无提交 ⇒ **抛错**，不返回猜测值。

`cloud-sync-test` 与 `api-push-test` 的断言收紧到**调用点**（原来看的是
`resolveRemoteRevision(`，函数定义本身就能匹配上，变异漏过）。

**变异测试**（每一条都实测变红）：

| 变异 | 被谁抓到 |
|---|---|
| `contentRevision` 改回 `contentRevisionAt('HEAD')` | `cloud-sync-test`（切片卡在写 catalog 之前） |
| 删掉自证段 | `cloud-sync-test`（必须读 catalog 现值） |
| `revision = pushedSha` | `api-push-test`（调用点断言） |
| `lib` 里把 `ref` 换成 `HEAD` | `catalog-revision-test`（本地落后远端用例） |
| 基线读到推送之后 | `api-push-test`（顺序断言） |

## 验证结果

| 项 | 结果 |
|---|---|
| `catalog-revision-test` | **14/14** |
| `cloud-sync-test` | **39/39** |
| `api-push-test` | **18/18** |
| `test-all --mode contributor` | **77/77 suites**（`reload` 这次也过了） |
| `test-all --mode release` | **3/3**（`catalog` 通过） |
| `typecheck` | 通过 |
| `host-selftest` | 通过 |

线上现状核对（用 API 读，绕开被阻断的 git 传输）：远端 `main` 的
`catalog/dsh-plugin.json` revision = `c85e27e`，本地对 `origin/main` 重算
= `c85e27e` —— **当前线上是一致的**，这一轮是把它锁死，不再靠人工纠偏。

## 边界

- 未 push、未改版本号。
- 没有改 `catalog-test.mjs`：它是**校验者**，故意保留自己那份独立实现。
  和写入方共用一份等于「用同一句话既写题又判卷」—— 实现错了会一起错。
- 云端仍是「推工作分支 → 刷新 → 推发布分支」，没有改变发布语义。
