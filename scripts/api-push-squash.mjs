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
import { fileURLToPath, pathToFileURL } from 'node:url'

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

/**
 * token 检查挪进 `main()` 之前的一次显式判定，且**只在直接执行时生效**。
 *
 * ⚠️ 原先它在模块顶层无条件 `process.exit(1)`，于是任何 `import` 本模块的
 * 脚本（如 `scripts/api-push-test.mjs` 的纯函数单测）都会因为「没有 GH_TOKEN」
 * 直接退出 —— 那段解析逻辑正是因此一直没被测试覆盖到。
 */
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly && (token === undefined || token === '')) {
  console.error('api-push-squash: 需要环境变量 GH_TOKEN')
  process.exit(1)
}

const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 512 * 1024 * 1024 }).toString()

/**
 * 删除条目在 GitHub tree API 里的 mode：**必须显式给合法值**。
 *
 * ## ⚠️ 真实缺陷（2026-10-19 线上实锤）
 *
 * `git diff-tree` 对删除记录给的是 `:100644 000000 <oldsha> 0000000000… D`，
 * 也就是 newMode = `"000000"`。原实现把它**原样**塞进 `POST /git/trees` 的
 * 条目里，GitHub 直接 422：
 *
 * ```
 * 422 Must supply a valid tree.mode
 * ```
 *
 * 因为 tree API 要求「删除条目 = sha 为 null + mode 是合法文件模式」，
 * 它不看 mode 的这段语义（全 0 只存在于 diff 文本里，不是 Git 对象模型的一部分）。
 * 用 `100644`（普通文件）即可 —— 条目已被 sha:null 标记为删除，mode 只用于校验。
 */
export const DELETED_ENTRY_MODE = '100644'

/**
 * 解析 `git diff-tree -r -z` 的输出为条目列表。
 *
 * 抽成纯函数只为一件事：**能被单测直接喂字符串**。原先是内联在一段带网络
 * 请求的循环里，删除条目的 mode 缺陷因此躲过了所有测试（线上才炸）。
 *
 * 输入格式：`:oldmode newmode oldsha newsha status\0path\0` 重复。
 *
 * @param {string} raw
 * @returns {Array<{ path: string, status: string, mode: string, oldSha: string, newSha: string }>}
 *   `mode` 已是**可直接发给 tree API** 的值（删除条目为 {@link DELETED_ENTRY_MODE}）。
 */
export function parseDiffTree(raw) {
  const parts = raw.split('\0').filter(Boolean)
  const entries = []
  let index = 0
  while (index < parts.length) {
    const meta = parts[index]
    const filePath = parts[index + 1]
    index += 2
    const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)$/.exec(meta)
    if (match === null) throw new Error(`无法解析 diff 记录: ${meta}`)
    const [, oldMode, newMode, oldSha, newSha, status] = match
    if (filePath === undefined) throw new Error(`diff 记录缺少路径: ${meta}`)
    /**
     * 删除条目（status D）：`newMode` 是 `000000`，**不能**原样发给 GitHub
     * （见 {@link DELETED_ENTRY_MODE} 的缺陷说明）。其余状态用 newMode
     *（可能是 `100644` 或 `100755`，可执行位要保留）。
     */
    const mode = status === 'D' ? DELETED_ENTRY_MODE : newMode
    entries.push({ path: filePath, status, mode, oldSha, newSha })
  }
  return entries
}

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
    throw new Error(describeApiError({ method, endpoint, status: response.status, message: payload.message ?? text.slice(0, 300) }))
  }
  return payload
}

/**
 * 把 GitHub API 的失败翻成**能照着做**的提示。
 *
 * ## 为什么需要它（2026-10-19 真实踩坑）
 *
 * 推送差异里含 `.github/workflows/*.yml` 时，若 PAT 没有 `workflow` scope，
 * GitHub 返回的是 **`404 Not Found`** —— 而不是 403。这个 404 **极有误导性**：
 * 看起来像「仓库不存在 / 路径写错 / 分支没了」，实际是权限范围不足。
 * 当时排查了很久才发现要加 `workflow` scope；更麻烦的是，**blob 与普通 tree
 * 写入都是成功的**（那些请求不碰 workflow 文件），只有最终建 tree 时才 404。
 *
 * 404 的另一种成因是 token 完全无效（会同时 401，这里已先被 401 分支覆盖）。
 *
 * @returns 带诊断提示的完整错误文案。
 */
export function describeApiError({ method, endpoint, status, message }) {
  const base = `${method} ${endpoint} -> HTTP ${status}: ${message}`
  if (status === 401) {
    return `${base}\n提示：token 无效或已过期。检查 GH_TOKEN / .private/gh-token。`
  }
  if (status === 404) {
    return `${base}\n提示：404 在 GitHub API 上有两种成因——\n`
      + '  (1) token 缺少 **workflow** scope：推送内容含 .github/workflows/ 时会返回 404（不是 403，极具误导性）。\n'
      + '      解决：新建 classic PAT，勾选 repo + workflow。\n'
      + '  (2) 仓库/分支/webhook 路径确实不存在，或 token 对该仓库无权限。'
  }
  if (status === 422) {
    return `${base}\n提示：载荷被拒。常见原因——tree 条目 mode 非法（删除条目必须 mode 合法且 sha:null）、`
      + '父提交/引用不匹配（并发写入）。'
  }
  if (status === 403) {
    return `${base}\n提示：权限不足或被限流。看响应头 x-ratelimit-remaining。`
  }
  return base
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
  const entries = parseDiffTree(raw)
  const items = []
  for (const entry of entries) {
    if (entry.status === 'D') {
      // 删除条目：见 parseDiffTree 的注释（mode 必须是合法值且 sha 为 null）。
      items.push({ path: entry.path, mode: entry.mode, type: 'blob', sha: null })
      console.log(`  D ${entry.path}`)
    } else {
      const sha = await uploadBlob(entry.newSha)
      items.push({ path: entry.path, mode: entry.mode, type: 'blob', sha })
      const kilobytes = Math.round(Number(execFileSync('git', ['cat-file', '-s', sha], { cwd: root })) / 1024)
      console.log(`  ${entry.status} ${entry.path} (${kilobytes} KB)`)
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

/**
 * 只在**被直接执行**时跑 main()。
 *
 * ⚠️ 原先无条件调用 `main()`，于是 `scripts/api-push-test.mjs` 一 import 本
 * 模块就会立刻执行推送逻辑（并要求 GH_TOKEN）—— 单测根本跑不起来。
 * 用 `pathToFileURL` 而不是手工拼 `file://`：本仓库路径含空格，
 * 手工拼接与 `import.meta.url` 的百分号编码形式永不相等（同类坑见
 * `check-sync-failure.mjs`）。
 */
if (invokedDirectly) {
  main().catch(error => {
    console.error(`api-push-squash: ❌ ${error.message}`)
    process.exit(1)
  })
}
