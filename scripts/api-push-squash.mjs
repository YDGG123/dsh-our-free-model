/**
 * 差异推送（squash 模式）：把本地 HEAD 相对远端 main 的差异作为一个提交
 * 推到远端 —— 本机到 github.com 的 git 传输被阻断时的推送通道。
 *
 * ## 与 api-push.mjs 的分工
 *
 * `api-push.mjs` 逐提交复刻历史，但 GitHub API 只给 UTC 时间、原提交的
 * 时区偏移丢失，commit 对象无法字节级复现（详见 api-fetch.mjs 头注）。
 * 本脚本因此不追求历史一致：以远端 tree 为 base_tree，只上传差异文件
 * （内容寻址保证 tree SHA 与本地逐字节一致），叠加为单个提交。
 * 详细历史保留在本地仓库。
 *
 * ## 用法
 *
 *     GH_TOKEN=... node scripts/api-push-squash.mjs
 *
 * ⚠️ 使用前先确认 REMOTE_SHA / REMOTE_TREE 与远端当前一致（可用
 * api-merge.mjs 拉取后 git diff-tree 比对），避免覆盖远端新提交。
 *
 * @module scripts/api-push-squash.mjs
 */

/**
 * 差异推送：只上传本地 HEAD 相对远端 main 的差异（~19 个文件），
 * 以远端 tree 为 base_tree 创建新 tree，再创建单个提交并移动引用。
 */
import { execFileSync } from 'node:child_process'

const TOKEN = process.env.GH_TOKEN
const API = 'https://api.github.com/repos/YDGG123/dsh-our-free-model'
const REMOTE_SHA = '8c2c0f1e3a1caf5cb682704a576d36a449a6780d'
const REMOTE_TREE = 'c06341262657f5ac6557582e05da0e2b42a151c1'
const root = process.cwd()
const git = (...a) => execFileSync('git', a, { cwd: root, maxBuffer: 512 * 1024 * 1024 }).toString()

let calls = 0
async function api(method, path, body) {
  calls++
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const t = await r.text()
  let j; try { j = t ? JSON.parse(t) : {} } catch { j = { raw: t } }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${j.message ?? t.slice(0, 200)}`)
  return j
}

async function uploadBlob(sha) {
  const bytes = execFileSync('git', ['cat-file', 'blob', sha], { maxBuffer: 512 * 1024 * 1024 })
  const p = await api('POST', '/git/blobs', { content: bytes.toString('base64'), encoding: 'base64' })
  if (p.sha !== sha) throw new Error(`blob ${sha} 上传后 SHA 不符: ${p.sha}`)
  return p.sha
}

// diff-tree -z 输出: ":oldmode newmode oldsha newsha status\0path\0" 每条记录
const raw = git('diff-tree', '-r', '-z', '--no-commit-id', REMOTE_TREE, 'HEAD')
const parts = raw.split('\0').filter(Boolean)
const items = []
let i = 0
while (i < parts.length) {
  const meta = parts[i]
  const path = parts[i + 1]
  i += 2
  const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)$/.exec(meta)
  if (!m) throw new Error(`无法解析 diff 记录: ${meta}`)
  const [, , newMode, , newSha, status] = m
  if (status === 'D') {
    items.push({ path, mode: newMode, type: 'blob', sha: null })
  } else {
    const sha = await uploadBlob(newSha)
    items.push({ path, mode: newMode, type: 'blob', sha })
    console.log(`  ${status} ${path} (${Math.round(execFileSync('git', ['cat-file', '-s', newSha]).toString() / 1024)} KB)`)
  }
}
console.log(`共 ${items.length} 个差异条目，全部上传完成`)

const tree = (await api('POST', '/git/trees', { base_tree: REMOTE_TREE, tree: items })).sha
console.log(`新 tree: ${tree.slice(0, 7)}`)

const message = `feat(fork): 在上游 v2.5.2 (8c2c0f1) 之上叠加本 fork 的定制

单一提交叠加。本机到 github.com 的 git 传输被阻断（仅 api.github.com
可达），完整提交历史保留在本地仓库；远端此提交的 tree 与本地 HEAD
完全一致。

内容（相对上游 8c2c0f1 的 19 个文件差异）：

1. Raccoon 按余额优先选号 + 锁定长期积分
   - raccoon-balance-selector.ts：三档选号（每日>长期>无），锁定时
     只留每日档；select 区分 exhausted/unknown
   - index.ts：resolveCredential/nextAccount/refresh 三处融合上游
     新契约与余额选号
   - PERMANENT_LOCK_PROVIDERS 加入 RACCOON
   - raccoon-balance-test.mjs：19 项离线回归

2. 更新源与签名信任根切换到本 fork
   - REPO=YDGG123/dsh-our-free-model（OFM_REPO 可覆盖）
   - 独立 Ed25519 公钥；manifest 已用配对私钥重签（2.5.2，77 文件）
   - 采纳上游新增的 gcore.jsdelivr 镜像；移除已废弃的 master 回退

3. 本机发布与 API 传输工具
   - fork-release.mjs：签名→复核→提交→推送 一条命令
   - api-fetch/api-merge/api-push：绕开被阻断的 git 通道
   - docs/FORK.md：密钥管理、发布、轮换步骤

验证：raccoon-balance 19/19；updater/catalog/manifest/feed/
client-lint 通过；全量 73/74（reload 套件在纯净上游分支同样失败，
属上游与 Node 24 的兼容问题，非本 fork 引入）。`

const now = new Date().toISOString()
const commit = await api('POST', '/git/commits', {
  message, tree, parents: [REMOTE_SHA],
  author: { name: 'YDGG123', email: 'YDGG123@users.noreply.github.com', date: now },
  committer: { name: 'YDGG123', email: 'YDGG123@users.noreply.github.com', date: now },
})
console.log(`新提交: ${commit.sha}`)

await api('PATCH', '/git/refs/heads/main', { sha: commit.sha })
console.log(`✅ 远端 main -> ${commit.sha.slice(0, 7)}（共 ${calls} 次 API 调用）`)
