/**
 * 通过 GitHub REST API 推送本地提交，绕开被阻断的 github.com git 传输。
 *
 * ## 为什么需要它
 *
 * 这台机器上 `api.github.com` 可达（~0.3 s），但 `github.com:443` 连不上
 * （超时）—— 所以 `git push` 必然失败，而同样的内容用 REST API 可以写进
 * 仓库。本脚本把本地 Git 对象图（blob / tree / commit）经 API 上传，最后
 * 更新分支引用。
 *
 * ## 算法
 *
 * 1. 从远端分支的现有 SHA 出发，找出**本地有、远端没有**的提交区间；
 * 2. 逐个提交，为其 tree 里每个 blob 调 `POST /git/blobs`（GitHub 按内容
 *    去重，重复上传无害）；
 * 3. 为每个目录调 `POST /git/trees`，`base_tree` 指向父提交的树，只发送
 *    该提交**相对父提交**变化的条目 —— 这既省请求，也避免重传整棵树；
 * 4. `POST /git/commits` 复刻作者、提交者、时间与消息；
 * 5. `PATCH /git/refs/heads/<branch>` 移动引用。
 *
 * ## 用法
 *
 *     node scripts/api-push.mjs --remote-sha <SHA> --branch main
 *     node scripts/api-push.mjs --remote-sha <SHA> --branch main --dry-run
 *
 * token 从环境变量 `GH_TOKEN` 读取（不要放命令行参数，会进 shell 历史）。
 *
 * @module scripts/api-push.mjs
 */

import fs from 'node:fs'
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
const has = name => argv.includes(`--${name}`)

const remoteSha = flag('remote-sha')
const branch = flag('branch') ?? 'main'
const dryRun = has('dry-run')
const token = process.env.GH_TOKEN

if (token === undefined || token === '') {
  console.error('api-push: 需要环境变量 GH_TOKEN')
  process.exit(1)
}
if (remoteSha === undefined || !/^[0-9a-f]{40}$/.test(remoteSha)) {
  console.error('api-push: 需要 --remote-sha <40位完整 SHA>（远端分支当前指向）')
  process.exit(1)
}

const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString()

let requestCount = 0
async function api(method, endpoint, body) {
  requestCount += 1
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'ofm-api-push',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload
  try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { raw: text } }
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} -> HTTP ${response.status}: ${payload.message ?? text.slice(0, 300)}`)
  }
  return payload
}

/**
 * Every commit reachable from HEAD but not from remoteSha, oldest first.
 *
 * `remoteSha` need not exist in the local object store (this machine cannot
 * fetch it — github.com is unreachable here), so the exclusion is done by
 * comparing against the remote commit's tree instead of by `rev-list A..B`.
 * Commits whose tree equals the running base are skipped: those are the ones
 * the remote already has.
 */
function commitsToPush(baseTree) {
  const all = git('rev-list', '--reverse', 'HEAD').split('\n').filter(Boolean)
  // Stop as soon as we reach a commit whose tree matches the remote's tree:
  // everything at or before it is already on the remote (the remote commit may
  // be a different SHA for the same content, because this machine cannot fetch
  // it and had to rebuild it from the API).
  const cut = all.findIndex(sha => commitInfo(sha).tree === baseTree)
  return cut === -1 ? all : all.slice(cut + 1)
}

/** Parent SHAs of a commit, in order. */
function parentsOf(sha) {
  return git('rev-list', '--parents', '-n', '1', sha).trim().split(' ').slice(1)
}

/** Metadata needed to recreate a commit exactly. */
function commitInfo(sha) {
  const raw = git('cat-file', 'commit', sha)
  const [header] = raw.split('\n\n')
  const field = name => {
    const match = new RegExp(`^${name} (.+)$`, 'm').exec(header)
    return match === null ? undefined : match[1]
  }
  const message = raw.slice(raw.indexOf('\n\n') + 2)
  return {
    tree: field('tree'),
    parents: parentsOf(sha),
    author: field('author'),
    committer: field('committer'),
    message,
  }
}

/** Parse a Git identity line ("Name <email> 1699999999 +0800"). */
function parseIdentity(line) {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line ?? '')
  if (match === null) throw new Error(`无法解析身份行：${line}`)
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() }
}

/** Changed entries between two trees, as { path -> {mode, type, sha} }. */
function diffTrees(fromTree, toTree) {
  const output = fromTree === undefined
    ? git('ls-tree', '-r', '-z', toTree)
    : git('diff-tree', '-r', '-z', '--no-commit-id', fromTree, toTree)
  const entries = []
  for (const record of output.split('\0').filter(Boolean)) {
    // -z form: ":oldmode newmode oldsha newsha STATUS\0path\0" for diffs,
    //          "mode type sha\tpath" for ls-tree.
    if (record.startsWith(':')) {
      const [meta, ...rest] = record.slice(1).split('\t')
      const [oldMode, newMode, , newSha, status] = meta.split(' ')
      entries.push({ path: rest.join('\t'), mode: newMode, sha: newSha, status, oldMode })
    } else {
      const tab = record.indexOf('\t')
      const [mode, type, sha] = record.slice(0, tab).split(' ')
      entries.push({ path: record.slice(tab + 1), mode, type, sha, status: 'A' })
    }
  }
  return entries
}

/** Upload one blob (by SHA from the local object store) and return its content. */
async function uploadBlob(sha) {
  const bytes = execFileSync('git', ['cat-file', 'blob', sha], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
  const payload = await api('POST', '/git/blobs', {
    content: bytes.toString('base64'),
    encoding: 'base64',
  })
  return payload.sha
}

/**
 * Build a tree for `commitSha` on top of `baseTree` (the remote's tree for the
 * parent commit). Only changed entries are sent; unchanged subtrees are shared.
 */
async function buildTree(commitSha, baseTree) {
  const info = commitInfo(commitSha)
  const parentTree = info.parents.length === 0 ? undefined : commitInfo(info.parents[0]).tree
  const entries = diffTrees(parentTree, info.tree)

  const treeItems = []
  for (const entry of entries) {
    // Deletion: null sha removes the path from base_tree.
    if (entry.status === 'D' || entry.sha === '0000000000000000000000000000000000000000') {
      treeItems.push({ path: entry.path, mode: entry.mode, type: 'blob', sha: null })
      continue
    }
    if (entry.mode === '160000') continue // submodule: 本仓库没有，跳过
    const sha = await uploadBlob(entry.sha)
    treeItems.push({ path: entry.path, mode: entry.mode, type: 'blob', sha })
  }

  if (treeItems.length === 0) return baseTree
  const payload = await api('POST', '/git/trees', {
    ...baseTree === undefined ? {} : { base_tree: baseTree },
    tree: treeItems,
  })
  return payload.sha
}

async function main() {
  // 先取远端树的 SHA 作为"已存在"的判据
  let remoteTree
  try {
    const remoteCommit = await api('GET', `/git/commits/${remoteSha}`)
    remoteTree = remoteCommit.tree.sha
  } catch (error) {
    throw new Error(`无法读取远端基线 ${remoteSha.slice(0, 7)}：${error.message}`)
  }
  const commits = commitsToPush(remoteTree)
  console.log(`api-push: 待推送 ${commits.length} 个提交 -> ${OWNER}/${REPO}@${branch}`)
  if (dryRun) {
    for (const sha of commits) console.log(`  ${sha.slice(0, 7)} ${git('log', '-1', '--format=%s', sha).trim()}`)
    console.log('api-push: --dry-run，未写入任何东西')
    return
  }

  // The remote's tree for remoteSha is the base for the first local commit.
  let baseTree
  try {
    const remoteCommit = await api('GET', `/git/commits/${remoteSha}`)
    baseTree = remoteCommit.tree.sha
    console.log(`api-push: 远端基线树 ${baseTree.slice(0, 7)}`)
  } catch (error) {
    // A shallow/absent remote commit means there is no shared base to build on.
    console.log(`api-push: 无法读取远端基线（${error.message}）—— 将逐提交完整建树`)
  }

  let lastSha = remoteSha
  for (const sha of commits) {
    const info = commitInfo(sha)
    const tree = await buildTree(sha, baseTree)
    const author = parseIdentity(info.author)
    const committer = parseIdentity(info.committer)
    const created = await api('POST', '/git/commits', {
      message: info.message,
      tree,
      parents: [lastSha],
      author,
      committer,
    })
    console.log(`  ✅ ${sha.slice(0, 7)} -> ${created.sha.slice(0, 7)}  ${git('log', '-1', '--format=%s', sha).trim().slice(0, 60)}`)
    lastSha = created.sha
    baseTree = tree
  }

  await api('PATCH', `/git/refs/heads/${branch}`, { sha: lastSha, force: true })
  console.log(`api-push: ✅ ${branch} 已更新到 ${lastSha.slice(0, 7)}（共 ${requestCount} 次 API 调用）`)
}

main().catch(error => {
  console.error(`api-push: ❌ ${error.message}`)
  process.exit(1)
})
