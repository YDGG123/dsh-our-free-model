# Fork 运维：更新源、签名密钥与发布

本仓库是 [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model)
的 **fork**（MIT，出处见 `LICENSE` 与 `catalog/provenance.json`）。这份文档只讲
**fork 自己的运维**，不重复上游的发布流程（见 `docs/RELEASING.md`）。

## 一、两处必须与上游不同的地方

| 位置 | 上游 | 本 fork | 为什么 |
|---|---|---|---|
| `src/updater.js` 的 `REPO` | `Ebony-Vinyl/dsh-our-free-model` | `YDGG123/dsh-our-free-model` | 指向上游会把上游版本装进来，**整体覆盖本 fork 的自有功能** |
| `src/updater.js` 的 `PINNED_MANIFEST_PUBLIC_KEY` | 上游公钥 | 本 fork 公钥 | 上游私钥我们没有也不该有；用上游公钥必然验签失败 |

两处是**成对**的：只改其中一个，升级路径就会一直失败（且报错令人困惑）。
运行时可整体覆盖仓库地址而无需改代码：

```bash
OFM_REPO=someone/else-fork dsh ...
```

## 二、签名密钥

### 现状

- 公钥：已钉在 `src/updater.js` 的 `PINNED_MANIFEST_PUBLIC_KEY`
  （`MCowBQYDK2VwAyEAdGHv5VxedVXfF0Hx8xqNKhVcq5KPObL/YzAU3lv3fEg=`）
- 私钥：**只存在于两个地方**
  1. 本机 `.private/ofm-release-key.pem`（已被 `.gitignore` 忽略，权限 `600`）
  2. GitHub 仓库 secret `RELEASE_MANIFEST_PRIVATE_KEY`

### 为什么私钥绝不能入库

清单里的每个文件都有 sha256，但**那些哈希就写在清单里** —— 能伪造清单的人
能同时伪造哈希。Ed25519 签名是伪造者跨不过去的那一步。把私钥提交进仓库，
等于把信任根和它保护的东西放在一起，签名的意义归零。

### 备份（重要）

私钥丢失的后果：**这个 fork 再也无法发布"可安装"的升级**。
`PINNED_MANIFEST_PUBLIC_KEY` 钉在已分发的构建里，那些构建只信任旧公钥 ——
所以换密钥无法通过升级流程本身完成，只能手工重新分发新构建。

因此请把 `.private/ofm-release-key.pem` 备份到密码管理器或加密存储。
**不要**提交、不要放进公开的 issue/PR、不要贴进聊天记录。

### 轮换密钥

只有在私钥泄露或丢失时才需要，步骤：

1. `node -e "..."` 生成新密钥对（见下方命令）
2. 用新公钥替换 `src/updater.js` 的 `PINNED_MANIFEST_PUBLIC_KEY`
3. 更新 GitHub secret
4. **手工**分发这一版（升级流程无法引导这次切换）
5. 用新私钥重跑 `fork-release` 工作流

生成新密钥对：

```bash
node -e "
const c=require('crypto');
const {publicKey,privateKey}=c.generateKeyPairSync('ed25519');
console.log('公钥(SPKI base64):', publicKey.export({type:'spki',format:'der'}).toString('base64'));
console.log('私钥(PKCS8 PEM):'); console.log(privateKey.export({type:'pkcs8',format:'pem'}));
"
```

## 三、发布一版

### 前提

- 改动已合并到 `main`
- `package.json` 的 `version` 已递增（清单会拒绝对同版本或更低版本重签）

### 一条命令（推荐）

```bash
node scripts/fork-release.mjs
```

它做四件事，任何一步失败都会停下并说明原因：

1. 检查工作区是否干净（脏树拒绝发布，避免签进未提交的改动）
2. 用 `.private/ofm-release-key.pem` 重签 `feed/manifest.json` 与 `catalog/*`
3. **独立复核**签名能否被钉死的公钥验证（不信任"上一步没报错"）
4. 提交并推送到 `fork/main`

其他模式：

```bash
node scripts/fork-release.mjs --no-push      # 只签名并提交到本地，先核对
node scripts/fork-release.mjs --check-only   # 只核对清单与磁盘是否一致（CI 用）
```

⚠️ **本机推送走 API，不走 git push。** 本机到 `github.com:443` 的 git 传输
被阻断（`api.github.com` 可达），`fork-release.mjs` 的推送步骤在这里会失败。
实际流程：

```bash
node scripts/fork-release.mjs --no-push   # 1. 签名 + 本地提交
GH_TOKEN=<token> node scripts/api-push-squash.mjs   # 2. 差异推送到远端
```

`api-push-squash.mjs` 以远端 tree 为基准只上传差异文件，tree SHA 与本地
逐字节一致（内容寻址自证）。使用前确认脚本头部的 `REMOTE_SHA` 与远端
当前一致，避免覆盖远端新提交。

私钥路径可用 `OFM_RELEASE_KEY` 覆盖。脚本会拒绝权限过宽的私钥（要求 `600`）。

> 为什么不用 GitHub Actions：推送 workflow 文件需要 token 具备 `workflow`
> scope，而本机的 gh token 没有该权限。本机脚本反而更直接——签名私钥本来就
> 只在这台机器上，不必为了签名把它复制到云端 secret。若以后想改成云端发布，
> 重新加回 `fork-release.yml` 即可，`RELEASE_MANIFEST_PRIVATE_KEY` secret
> 已经配置好。

### 在本机

```bash
# 签名（私钥在本地时）
node scripts/build-manifest.mjs --key .private/ofm-release-key.pem

# 只检查清单是否与磁盘一致（CI 也跑这个）
node scripts/build-manifest.mjs --check --key .private/ofm-release-key.pem
```

⚠️ `--check` **不加 `--key`** 时只能核对哈希，无法核对签名 —— 签名复核需要
公钥，而公钥在代码里，所以 `--check` 不带 key 也能验证已提交清单的签名。

## 四、装到本机

插件在 DSH 里以软链方式安装时，工作区改动即刻生效（改完 `pack.js` 后需要
让宿主重载插件）。走**升级路径**则：

1. 插件面板点检查更新 → 发现新版本
2. 应用后自动校验清单签名与每个文件的 sha256
3. 失败会回滚到备份（见 `docs/issue-93-upgrade-recovery.md`）

## 五、与上游同步（已自动化）

本 fork 的定位是「上游的功能 + 自己的功能都要」。`scripts/sync-upstream.mjs`
由 launchd 每日 11:30 触发（`~/Library/LaunchAgents/com.ydgg.ofm-sync-upstream.plist`）：

1. 经镜像 fetch 上游 main（免认证）
2. 已在本地历史 → 退出；有新提交 → 合并
3. **只有生成产物冲突时自动解决**（manifest/catalog/pack.js 取 ours 后
   重建重签）；源码冲突 → 回滚并留待人工
4. 重建 pack.js → catalog revision 跟随 → 重签 manifest
5. 目标测试集（raccoon-balance/updater/catalog/chan-relay/feed/picks），
   失败 → 回滚到合并前，远端不受影响
6. `api-push-squash` 推送，游标写入 `.private/upstream-sync-state.json`

手动运行 / 查看日志：

```bash
node scripts/sync-upstream.mjs            # 手动同步
node scripts/sync-upstream.mjs --dry-run  # 到推送前为止
tail .private/sync.log                    # 日志
launchctl kickstart -k gui/$(id -u)/com.ydgg.ofm-sync-upstream  # 立即触发
```

降低冲突的两条纪律：

1. **新功能写成新文件**，在共享文件里只留最少的挂载点
   （例：`raccoon-balance-selector.ts` 是独立模块，`index.ts` 只改接线处）
2. **不要删除上游文件**（`packages/`、README 等）。它们不参与打包、不被
   代码引用，留着零成本；删掉则上游每次改动都产生冲突。
