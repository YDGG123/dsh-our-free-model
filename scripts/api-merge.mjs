/**
 * 把远端某个提交的**文件内容**取到本地工作区，用于合并上游更新。
 *
 * ## 与 `api-fetch.mjs` 的区别
 *
 * `api-fetch.mjs` 试图在本地重建远端 commit 对象，以便 `git merge` 直接使用。
 * 它能把 **tree 和 blob 精确重建**（内容寻址，SHA 自证），但 **commit 对象
 * 本身无法字节级复现**：GitHub 的 REST API 只给 UTC 时间，原提交的时区
 * 偏移（如 +0800）丢失了，而时区是 commit 对象字节的一部分。所以重建出的
 * commit SHA 必然不同。
 *
 * 本脚本因此不碰 commit 对象，只做**内容搬运**：
 *
 * 1. 从 API 取目标提交的 tree（递归展开），把每个 blob 写入本地对象库；
 * 2. 用 `git read-tree` 把该 tree 落到一个临时索引；
 * 3. `git checkout-index` 把文件写进工作区。
 *
 * 之后你就有了「上游最新代码」的文件快照，可以用普通的 `git add` + 合并
 * 流程把它与本地改动结合。
 *
 * ## 用法
 *
 *     GH_TOKEN=... node scripts/api-merge.mjs --sha <REMOTE_COMMIT> --into <branch>
 *
 * 它会新建一个 `upstream-sync` 分支承载上游内容，便于与 `custom-main` 对比
 * 和合并，不会直接改动你的工作分支。
 *
 * @module scripts/api-merge.mjs
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const OWNER = 'YDGG123'
const REPO = 'dsh-our-free-model'
const API = `https://api.github.com/repos/${OWNER}/${REPO}`

const argv = process.argv.slice(2)
const flag = name => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

const remoteSha = flag('sha')
const token = process.env.GH_TOKEN

if (token === undefined || token === '') {
  console.error('api-merge: 需要环境变量 GH_TOKEN')
  process.exit(1)
}
if (remoteSha === undefined || !/^[0-9a-f]{40}$/.test(remoteSha)) {
  console.error('api-merge: 需要 --sha <40位完整 SHA>')
  process.exit(1)
}

const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 512 * 1024 * 1024 }).toString()

let requests = 0
async function api(endpoint) {
  requests += 1
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`${API}${endpoint}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'ofm-api-merge',
      },
    })
    if (response.ok) return response.json()
    if (response.status === 403 || response.status === 429) {
      const retry = Number(response.headers.get('retry-after') ?? '5')
      console.log(`api-merge: 限流，${retry}s 后重试`)
      await new Promise(resolve => setTimeout(resolve, retry * 1000))
      continue
    }
    throw new Error(`GET ${endpoint} -> HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
  throw new Error(`GET ${endpoint} -> 多次重试仍失败`)
}

function have(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', sha], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function writeObject(type, bytes) {
  return execFileSync('git', ['hash-object', '-w', '-t', type, '--stdin'], {
    cwd: root, input: bytes, maxBuffer: 512 * 1024 * 1024,
  }).toString().trim()
}

/** `040000` (API) -> `40000` (on-disk tree format). */
const canonicalMode = mode => mode === '040000' ? '40000' : mode

/** Fetch one blob into the local object store, verifying its SHA. */
async function fetchBlob(sha) {
  if (have(sha)) return
  const payload = await api(`/git/blobs/${sha}`)
  const bytes = payload.encoding === 'base64'
    ? Buffer.from(payload.content, 'base64')
    : Buffer.from(payload.content, 'utf8')
  const written = writeObject('blob', bytes)
  if (written !== sha) throw new Error(`blob 校验失败：期望 ${sha}，实际 ${written}`)
}

/** Rebuild a tree object from the API listing, verifying its SHA. */
async function fetchTree(sha) {
  if (have(sha)) return
  const payload = await api(`/git/trees/${sha}`)
  if (payload.truncated === true) throw new Error(`tree ${sha.slice(0, 7)} 被截断`)
  const sorted = [...payload.tree].sort((a, b) => {
    const keyOf = entry => entry.type === 'tree' ? `${entry.path}/` : entry.path
    return Buffer.compare(Buffer.from(keyOf(a)), Buffer.from(keyOf(b)))
  })
  const chunks = []
  for (const entry of sorted) {
    if (entry.type === 'tree') await fetchTree(entry.sha)
    else if (entry.type === 'blob') await fetchBlob(entry.sha)
    const mode = canonicalMode(entry.mode)
    chunks.push(Buffer.concat([
      Buffer.from(`${mode} `),
      Buffer.from(entry.path, 'utf8'),
      Buffer.from([0]),
      Buffer.from(entry.sha, 'hex'),
    ]))
  }
  const written = writeObject('tree', Buffer.concat(chunks))
  if (written !== sha) throw new Error(`tree 校验失败：期望 ${sha}，实际 ${written}`)
}

async function main() {
  console.log(`api-merge: 取 ${OWNER}/${REPO} 的 ${remoteSha.slice(0, 7)} 内容`)

  const commit = await api(`/git/commits/${remoteSha}`)
  const tree = commit.tree.sha
  console.log(`api-merge: tree ${tree.slice(0, 7)}（${commit.message.split('\n')[0].slice(0, 50)}）`)

  await fetchTree(tree)
  console.log(`api-merge: ✅ 内容就绪（${requests} 次 API 调用）`)
  console.log(`api-merge: tree SHA = ${tree}`)
  console.log('')
  console.log('  下一步（把上游内容落成一个分支）：')
  console.log(`    git checkout --detach HEAD`)
  console.log(`    git read-tree ${tree}`)
  console.log(`    git checkout-index -a -f`)
  console.log(`    git add -A && git commit -m "sync: upstream ${remoteSha.slice(0, 7)}"`)
}

main().catch(error => {
  console.error(`api-merge: ❌ ${error.message}`)
  process.exit(1)
})
