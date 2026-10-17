/**
 * 差异推送（squash 模式）：把本地 HEAD 相对远端 main 的差异作为一个提交
 * 推到远端 —— 本机到 github.com 的 git 传输被阻断时的推送通道。
 *
 * ## 工作方式
 *
 * 1. 向 API 查询远端 main 当前的 commit SHA 及其 tree（自动发现，
 *    无硬编码 —— 脚本因此可以反复运行）；
 * 2. `git diff-tree` 计算本地 HEAD 相对该 tree 的差异（通常几十个文件）；
 * 3. 逐个上传差异 blob（内容寻址：SHA 不符即中止）；
 * 4. 以远端 tree 为 base_tree 创建新 tree，创建单个提交（父 = 远端 main）；
 * 5. 更新远端引用。
 *
 * tree SHA 与本地逐字节一致（Git 内容寻址自证），所以远端内容与本地
 * 完全等价；只有提交历史是压扁的 —— 完整历史保留在本地仓库。
 *
 * ## 与 api-push.mjs 的分工
 *
 * `api-push.mjs` 逐提交复刻历史，但 GitHub API 只给 UTC 时间、原提交的
 * 时区偏移丢失，commit 对象无法字节级复现（见 api-fetch.mjs 头注）。
 * 本脚本不追求历史一致，只保证内容一致。
 *
 * ## 用法
 *
 *     GH_TOKEN=... node scripts/api-push-squash.mjs [--check] [--message-file <path>]
 *
 * `--check` 只打印将推送的差异，不写任何东西。`--message-file` 指定提交
 * 消息；缺省生成描述差异的默认消息。
 *
 * @module scripts/api-push-squash.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const OWNER = 'YDGG123'
const REPO = 'dsh-our-free-model'
const API = `https://api.github.com/repos/${OWNER}/${REPO}`
const BRANCH = process.env.OFM_PUSH_BRANCH ?? 'main'

const argv = process.argv.slice(2)
const has = name => argv.includes(`--${name}`)
const flag = name => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}
const checkOnly = has('check')
const messageFile = flag('message-file')
const token = process.env.GH_TOKEN

if (token === undefined || token === '') {
  console.error('api-push-squash: 需要环境变量 GH_TOKEN')
  process.exit(1)
}

const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 512 * 1024 * 1024 }).toString()

let calls = 0
async function api(method, endpoint, body) {
  calls += 1
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'ofm-api-push-squash',
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

async function uploadBlob(sha) {
  const bytes = execFileSync('git', ['cat-file', 'blob', sha], { cwd: root, maxBuffer: 512 * 1024 * 1024 })
  const payload = await api('POST', '/git/blobs', { content: bytes.toString('base64'), encoding: 'base64' })
  if (payload.sha !== sha) throw new Error(`blob ${sha} 上传后 SHA 不符: ${payload.sha}`)
  return payload.sha
}

async function main() {
  // 1. 发现远端现状（无硬编码 —— 反复运行安全）。
  const ref = await api('GET', `/git/refs/heads/${BRANCH}`)
  const remoteSha = ref.object.sha
  const remoteCommit = await api('GET', `/git/commits/${remoteSha}`)
  const remoteTree = remoteCommit.tree.sha
  console.log(`远端 ${BRANCH}: ${remoteSha.slice(0, 7)} (tree ${remoteTree.slice(0, 7)})`)

  const localHead = git('rev-parse', 'HEAD').trim()
  const localTree = git('rev-parse', 'HEAD^{tree}').trim()
  console.log(`本地 HEAD: ${localHead.slice(0, 7)} (tree ${localTree.slice(0, 7)})`)

  if (localTree === remoteTree) {
    console.log('✅ 内容已一致，无需推送')
    return
  }

  // 2. 差异清单（-z 格式：":oldmode newmode oldsha newsha status\0path\0"）。
  const raw = git('diff-tree', '-r', '-z', '--no-commit-id', remoteTree, 'HEAD')
  const parts = raw.split('\0').filter(Boolean)
  const items = []
  let index = 0
  while (index < parts.length) {
    const meta = parts[index]
    const filePath = parts[index + 1]
    index += 2
    const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)$/.exec(meta)
    if (match === null) throw new Error(`无法解析 diff 记录: ${meta}`)
    const [, , newMode, , newSha, status] = match
    if (status === 'D') {
      items.push({ path: filePath, mode: newMode, type: 'blob', sha: null })
      console.log(`  D ${filePath}`)
    } else {
      const sha = await uploadBlob(newSha)
      items.push({ path: filePath, mode: newMode, type: 'blob', sha })
      const kilobytes = Math.round(Number(execFileSync('git', ['cat-file', '-s', newSha], { cwd: root })) / 1024)
      console.log(`  ${status} ${filePath} (${kilobytes} KB)`)
    }
  }
  if (items.length === 0) {
    console.log('✅ 无差异条目')
    return
  }
  console.log(`共 ${items.length} 个差异条目`)

  if (checkOnly) {
    console.log('--check：未写入任何东西')
    return
  }

  // 3. 新 tree（base_tree = 远端，只发差异）。
  const tree = (await api('POST', '/git/trees', { base_tree: remoteTree, tree: items })).sha
  console.log(`新 tree: ${tree.slice(0, 7)}`)

  // 4. 单个提交，父 = 远端 main。
  const message = messageFile !== undefined
    ? fs.readFileSync(messageFile, 'utf8')
    : `chore(fork): 同步本地内容（${items.length} 个文件差异）

本地 HEAD ${localHead.slice(0, 7)}；远端基线 ${remoteSha.slice(0, 7)}。
由 scripts/api-push-squash.mjs 生成：内容与本地逐字节一致（tree
${tree.slice(0, 7)}），历史压扁，完整提交历史在本地仓库。`
  const now = new Date().toISOString()
  const commit = await api('POST', '/git/commits', {
    message,
    tree,
    parents: [remoteSha],
    author: { name: 'YDGG123', email: 'YDGG123@users.noreply.github.com', date: now },
    committer: { name: 'YDGG123', email: 'YDGG123@users.noreply.github.com', date: now },
  })
  console.log(`新提交: ${commit.sha.slice(0, 7)}`)

  // 5. 移动引用（指向自己刚建的提交；force 以防推送竞态覆盖中间提交）。
  await api('PATCH', `/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true })
  console.log(`✅ 远端 ${BRANCH} -> ${commit.sha.slice(0, 7)}（共 ${calls} 次 API 调用）`)
}

main().catch(error => {
  console.error(`api-push-squash: ❌ ${error.message}`)
  process.exit(1)
})
