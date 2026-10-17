/**
 * 通过 GitHub REST API 把远端提交图拉进本地 Git 对象库，绕开被阻断的
 * `github.com:443` git 传输。
 *
 * ## 为什么需要它
 *
 * 这台机器上 `api.github.com` 可达（~0.3 s），而 `github.com:443` 超时 ——
 * 所以 `git fetch` 拉不动。但同样的对象可以从 REST API 取回：本脚本把
 * commit / tree / blob 逐个下载并**写成本地 Git 对象**（`git hash-object -w`），
 * 之后本地就拥有了那个提交，`git log` / `git merge` / `git rebase` 都能用。
 *
 * ## 关键性质：SHA 自证
 *
 * Git 对象的内容寻址意味着**不需要信任传输通道**：写进本地对象库的字节
 * 必须哈希成 API 报告的那个 SHA，否则 `git hash-object -w` 会给出不同的
 * 值、脚本会拒绝。所以哪怕镜像或代理篡改了内容，也只会导致校验失败，
 * 不会污染仓库。
 *
 * ## 用法
 *
 *     GH_TOKEN=... node scripts/api-fetch.mjs --sha <COMMIT_SHA> [--depth N]
 *
 * `--depth N` 只取最近 N 个提交（默认全部）。取回的提交在本地表现为一个
 * 游离对象图，用 `git merge <SHA>` 或 `git rebase <SHA>` 使用。
 *
 * @module scripts/api-fetch.mjs
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

const startSha = flag('sha')
const depth = flag('depth') === undefined ? Number.POSITIVE_INFINITY : Number(flag('depth'))
const token = process.env.GH_TOKEN

if (token === undefined || token === '') {
  console.error('api-fetch: 需要环境变量 GH_TOKEN')
  process.exit(1)
}
if (startSha === undefined || !/^[0-9a-f]{40}$/.test(startSha)) {
  console.error('api-fetch: 需要 --sha <40位完整 SHA>')
  process.exit(1)
}

let requests = 0
async function api(endpoint) {
  requests += 1
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`${API}${endpoint}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'ofm-api-fetch',
      },
    })
    if (response.ok) return response.json()
    if (response.status === 403 || response.status === 429) {
      const retry = Number(response.headers.get('retry-after') ?? '5')
      console.log(`api-fetch: 限流，${retry}s 后重试（第 ${attempt} 次）`)
      await new Promise(resolve => setTimeout(resolve, retry * 1000))
      continue
    }
    throw new Error(`GET ${endpoint} -> HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
  throw new Error(`GET ${endpoint} -> 多次重试仍失败`)
}

/** Write bytes into the local object store and return the resulting SHA. */
function writeObject(type, bytes) {
  const sha = execFileSync('git', ['hash-object', '-w', '-t', type, '--stdin'], {
    cwd: root,
    input: bytes,
    maxBuffer: 512 * 1024 * 1024,
  }).toString().trim()
  return sha
}

/** Does this object already exist locally? */
function have(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', sha], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Git's canonical mode spelling inside a tree object.
 *
 * ⚠️ The REST API reports directory modes as `040000` (six digits), but the
 * on-disk tree format writes `40000` — no leading zero. Using the API spelling
 * verbatim produces a *different* tree object whose SHA will not match, which
 * is exactly how this was caught: `hash-object -w` returned 9edf397… for a
 * tree the API said was 4fa6146…, and the byte comparison showed the extra
 * `0`. Regular files are `100644` and executables `100755` in both spellings,
 * so only the directory case needs normalizing.
 */
function canonicalMode(mode) {
  return mode === '040000' ? '40000' : mode
}

/**
 * Recreate a tree object locally.
 *
 * Git tree objects are binary: a sequence of `<mode> <name>\0<20-byte sha>`.
 * We rebuild them from the API's textual listing, which is exactly the inverse
 * of what `git ls-tree` prints.
 */
async function fetchTree(sha) {
  if (have(sha)) return
  const payload = await api(`/git/trees/${sha}`)
  if (payload.truncated === true) {
    throw new Error(`tree ${sha.slice(0, 7)} 被 API 截断，需要改用递归方式分块拉取`)
  }
  const chunks = []
  // Git requires entries sorted with tree-specific ordering: directories are
  // compared as if their name had a trailing "/".
  const sorted = [...payload.tree].sort((a, b) => {
    const keyOf = entry => entry.type === 'tree' ? `${entry.path}/` : entry.path
    return Buffer.compare(Buffer.from(keyOf(a)), Buffer.from(keyOf(b)))
  })
  for (const entry of sorted) {
    const mode = canonicalMode(entry.mode)
    const name = Buffer.from(entry.path, 'utf8')
    if (entry.type === 'tree') {
      await fetchTree(entry.sha)
    } else if (entry.type === 'blob') {
      await fetchBlob(entry.sha)
    }
    // Submodule entries (type 'commit') need no local object; the tree just
    // records the commit SHA it points at.
    chunks.push(Buffer.concat([Buffer.from(`${mode} `), name, Buffer.from([0]), Buffer.from(entry.sha, 'hex')]))
  }
  const written = writeObject('tree', Buffer.concat(chunks))
  if (written !== sha) {
    throw new Error(`tree 校验失败：期望 ${sha}，实际写入 ${written}（内容被篡改或重建有误）`)
  }
}

async function fetchBlob(sha) {
  if (have(sha)) return
  const payload = await api(`/git/blobs/${sha}`)
  const bytes = payload.encoding === 'base64'
    ? Buffer.from(payload.content, 'base64')
    : Buffer.from(payload.content, 'utf8')
  const written = writeObject('blob', bytes)
  if (written !== sha) {
    throw new Error(`blob 校验失败：期望 ${sha}，实际 ${written}`)
  }
}

/** Recreate a commit object locally (message + author + committer + parents). */
async function fetchCommit(sha) {
  if (have(sha)) return { existed: true, payload: null }
  const payload = await api(`/git/commits/${sha}`)
  return { existed: false, payload }
}

/**
 * Serialize a commit object exactly as Git stores it.
 *
 * ⚠️ Two details decide whether the resulting SHA matches:
 *
 * - **The message ends with a newline.** Git always stores `…message\n`; the
 *   REST API returns the message with trailing whitespace trimmed. Omitting
 *   that final `\n` produced a commit whose SHA differed from the API's in
 *   every attempt (measured: expected 6038fdd…, wrote 49e0dba…).
 * - **The timezone offset is fixed at `+0000`.** The API reports instants in
 *   UTC (`…Z`) and does not carry the original offset, so a commit made in
 *   +0800 cannot be byte-identical through this path. That only matters for
 *   reproducing someone else's commit verbatim; the tree — which is what the
 *   working copy consists of — is exact, and local commits we create use our
 *   own identity anyway.
 */
function commitBytes(payload, parentShas) {
  const lines = [`tree ${payload.tree.sha}`]
  for (const parent of parentShas) lines.push(`parent ${parent}`)
  lines.push(`author ${payload.author.name} <${payload.author.email}> ${Math.floor(new Date(payload.author.date).getTime() / 1000)} +0000`)
  lines.push(`committer ${payload.committer.name} <${payload.committer.email}> ${Math.floor(new Date(payload.committer.date).getTime() / 1000)} +0000`)
  const message = payload.message.endsWith('\n') ? payload.message : `${payload.message}\n`
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8')
}

async function main() {
  console.log(`api-fetch: 从 ${OWNER}/${REPO} 拉取 ${startSha.slice(0, 7)}（depth=${depth === Number.POSITIVE_INFINITY ? 'all' : depth}）`)

  const queue = [startSha]
  const seen = new Set()
  const ordered = []

  // Breadth-first walk over parents, stopping at `depth` commits.
  while (queue.length > 0 && ordered.length < depth) {
    const sha = queue.shift()
    if (seen.has(sha)) continue
    seen.add(sha)
    const { existed, payload } = await fetchCommit(sha)
    if (existed) {
      // Already local: its ancestors are too (we only ever fetch missing ones),
      // so this is a safe place to stop walking this branch.
      ordered.push({ sha, existed: true })
      continue
    }
    ordered.push({ sha, existed: false, payload })
    for (const parent of payload.parents) queue.push(parent.sha)
  }

  // Rebuild oldest-first so parents exist before children reference them.
  for (const entry of [...ordered].reverse()) {
    if (entry.existed) continue
    const payload = entry.payload
    await fetchTree(payload.tree.sha)
    const parentShas = payload.parents.map(p => p.sha)
    const written = writeObject('commit', commitBytes(payload, parentShas))
    if (written !== entry.sha) {
      throw new Error(`commit 校验失败：期望 ${entry.sha}，实际 ${written}`)
    }
  }

  console.log(`api-fetch: ✅ ${ordered.length} 个提交就绪（${requests} 次 API 调用）`)
  console.log(`api-fetch: 现在可以 git log / git merge / git rebase ${startSha.slice(0, 7)}`)
}

main().catch(error => {
  console.error(`api-fetch: ❌ ${error.message}`)
  process.exit(1)
})
