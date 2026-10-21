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
import {
  catalogRevision,
  isReleaseContentPath,
  readReleaseContentPaths,
  remoteContentRevision,
} from './lib/catalog-revision.mjs'

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

/**
 * 这次推送有没有动发布内容 —— 降级路径下 revision 取谁，由它决定。
 *
 * ## ⚠️ 为什么单独导出（真实缺陷，2026-10-21 真机推送）
 *
 * 原先是内联在 `pushOneCommit` 里的一行。`isReleaseContentPath` **用了却没
 * import**，于是 `pushOneCommit` 一跑到这行就 `ReferenceError` 中断，main 推送
 * 当场失败。而当时**所有用例都是绿的**：这条判定藏在需要网络的
 * `pushOneCommit` 深处，没有任何测试真正**执行**过它 —— 用例只测了 helper
 * 本身（那个文件里 `isReleaseContentPath` 是本地定义），没测这里的引用。
 *
 * 导出之后，用例可以直接喂 entries 调用它：缺 import 会在测试里立刻炸出来，
 * 而不是等到真机推送。
 *
 * @param {Array<{ path: string }>} entries `parseDiffTree` 的差异清单
 * @param {string[]} releasePaths 发布内容路径（`readReleaseContentPaths`）
 * @returns {boolean}
 */
export function pushTouchesReleaseContent(entries, releasePaths) {
  return entries.some(entry => isReleaseContentPath(entry.path, releasePaths))
}

/**
 * 以 `baseSha` 为远端基线，把**本地工作树的内容**推成**一个**提交。
 *
 * 抽成函数只为一件事：两段式推送的第二段要复用同一套差异推送（第二次
 * 差异只含 catalog/feed）。原先是内联在 `main()` 里的一大段，没法复用。
 *
 * @returns `null`（内容已一致，无需推送）或
 *   `{ sha, touchedReleaseContent }` —— 后者告诉调用方这次推送**有没有动
 *   发布内容**，是「远端 revision 到底是谁」的判据之一（见
 *   {@link resolveRemoteRevision} 的降级路径）。
 */
async function pushOneCommit({ baseSha, message, verbose = true }) {
  const say = verbose ? console.log : () => {}
  const remoteCommit = await api('GET', `/git/commits/${baseSha}`)
  const remoteTree = remoteCommit.tree.sha
  const localTree = git('rev-parse', 'HEAD^{tree}').trim()
  if (localTree === remoteTree) return null

  // 差异清单（-z 格式：":oldmode newmode oldsha newsha status\0path\0"）。
  const raw = git('diff-tree', '-r', '-z', '--no-commit-id', remoteTree, 'HEAD')
  const entries = parseDiffTree(raw)
  const releasePaths = readReleaseContentPaths({ root })
  const touchedReleaseContent = pushTouchesReleaseContent(entries, releasePaths)
  const items = []
  for (const entry of entries) {
    if (entry.status === 'D') {
      // 删除条目：见 parseDiffTree 的注释（mode 必须是合法值且 sha 为 null）。
      items.push({ path: entry.path, mode: entry.mode, type: 'blob', sha: null })
      say(`  D ${entry.path}`)
    } else {
      const sha = await uploadBlob(entry.newSha)
      items.push({ path: entry.path, mode: entry.mode, type: 'blob', sha })
      if (verbose) {
        const kilobytes = Math.round(Number(execFileSync('git', ['cat-file', '-s', sha], { cwd: root })) / 1024)
        say(`  ${entry.status} ${entry.path} (${kilobytes} KB)`)
      }
    }
  }
  if (items.length === 0) return null
  say(`共 ${items.length} 个差异条目`)

  const tree = (await api('POST', '/git/trees', { base_tree: remoteTree, tree: items })).sha
  say(`新 tree: ${tree.slice(0, 7)}`)

  const now = new Date().toISOString()
  const commit = await api('POST', '/git/commits', {
    message,
    tree,
    parents: [baseSha],
    author: { name: 'YDGG123', email: 'YDGG123@users.noreply.github.com', date: now },
    committer: { name: 'YDGG123', email: 'YDGG123@users.noreply.github.com', date: now },
  })
  say(`新提交: ${commit.sha.slice(0, 7)}`)

  // 移动引用（指向自己刚建的提交；force 以防推送竞态覆盖中间提交）。
  await api('PATCH', `/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true })
  return { sha: commit.sha, touchedReleaseContent }
}

/** 读远端 catalog 里当前记录的 revision（降级路径用；读不到返回 `undefined`）。 */
async function readRemoteCatalogRevision() {
  try {
    const payload = await api('GET', `/contents/catalog/dsh-plugin.json?ref=${BRANCH}`)
    const text = payload.content === undefined
      ? ''
      : Buffer.from(payload.content, payload.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
    if (text === '') return undefined
    return JSON.parse(text)?.source?.revision
  } catch {
    return undefined
  }
}

/**
 * 本进程内 git 传输是否已被判定不可用。
 *
 * ## 为什么需要它（本机实测，2026-10-20）
 *
 * 本机到 `github.com:443` 的 git 传输是被**阻断**的：三次实测分别 2 分 06 秒
 * （HTTP2 framing）、1 分 15 秒 ×2（连不上），单次要等 75 秒才超时 —— 这正是
 * 本脚本走 API 通道的原因。于是「远端重算」在本机几乎必然失败，而
 * `resolveRemoteRevision` 与推送后的自证会**各试一次**：两次 75 秒的等待纯属
 * 浪费，还会拖长 launchd 的定时任务。
 *
 * 第一次判定失败后就记住，后续调用直接走降级判据，不再重试。
 */
let gitTransportUnavailable = false

/**
 * 决定第二段该把 catalog 的 revision 写成什么 —— **只认远端真相**。
 *
 * ## 主路径（云端 runner / git 传输可用时）
 *
 * `git fetch` 远端分支，在 `origin/<branch>` 上跑 `catalog-test` 的同一条
 * `git log`。算法收在 `scripts/lib/catalog-revision.mjs`，与 `sync-upstream.mjs`
 * 共用一份 —— 两次口径漂移都是「各写一套」造成的。
 *
 * ## 为什么要有降级路径
 *
 * 本机走 API 通道的**原因**就是 `github.com:443` 的 git 传输被阻断（见
 * `api-fetch.mjs` 头注）。所以这里不能假定 fetch 一定可用：
 *
 * - 这次推送**碰了发布内容** ⇒ squash 出来的那个提交本身就是「最后触碰
 *   发布内容的提交」，远端重算值必然等于它；
 * - 这次推送**没碰发布内容** ⇒ 远端 revision 不变，沿用**推送前**读到的
 *   远端 catalog 现值。
 *
 * ⚠️ `baselineRevision` 必须是**第一段推送之前**读到的值。第二段推送完再读
 * 远端 catalog 是错的 —— 那时读到的已经是我们自己刚推上去的内容，于是
 * 「保持现值」变成「把过期值原样写回去」，等于什么都没修（一开始就写错了）。
 *
 * 两条都拿不到 ⇒ **报错**，绝不猜一个 sha 写进去。
 *
 * @param {{ pushedSha: string, touchedReleaseContent: boolean,
 *           baselineRevision?: string }} input
 *   `baselineRevision` 是推送前远端 catalog 的 revision（读不到则 `undefined`）。
 * @returns {Promise<{ revision: string, source: 'remote'|'pushed'|'baseline' }>}
 */
async function resolveRemoteRevision({ pushedSha, touchedReleaseContent, baselineRevision }) {
  if (!gitTransportUnavailable) {
    try {
      // 本机连不上 github 时单次要等 75 秒 ⇒ 只给一次机会、20 秒上限。
      // 云端（runner 直连）正常是秒级，这个上限也够。
      const computed = remoteContentRevision(BRANCH, { root, attempts: 1, timeout: 20_000 })
      console.log(`  远端重算 revision = ${computed.slice(0, 7)}（git fetch）`)
      return { revision: computed, source: 'remote' }
    } catch (error) {
      gitTransportUnavailable = true
      console.log(`⚠️ git fetch 不可用（${String(error.message).split('\n')[0]}），改走 API 判据`)
    }
  }
  if (touchedReleaseContent) {
    console.log(`  本次推送动了发布内容 ⇒ revision = ${pushedSha.slice(0, 7)}（squash 提交本身）`)
    return { revision: pushedSha, source: 'pushed' }
  }
  if (typeof baselineRevision === 'string' && /^[0-9a-f]{40}$/.test(baselineRevision)) {
    console.log(`  本次推送未动发布内容 ⇒ revision 保持推送前现值 ${baselineRevision.slice(0, 7)}`)
    return { revision: baselineRevision, source: 'baseline' }
  }
  throw new Error(
    '无法确定远端 revision：git fetch 不可用，且既没动发布内容、也没读到推送前的 catalog 现值。'
    + '拒绝写入猜测值（宁可失败，也不留一个说谎的发布）。',
  )
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

  if (checkOnly) {
    // `--check` 只列差异，不写任何东西（沿用原来的行为）。
    const entries = parseDiffTree(git('diff-tree', '-r', '-z', '--no-commit-id', remoteTree, 'HEAD'))
    for (const entry of entries) {
      const note = entry.status === 'D' ? `mode ${entry.mode}` : `${Math.round(Number(execFileSync('git', ['cat-file', '-s', entry.newSha], { cwd: root })) / 1024)} KB`
      console.log(`  ${entry.status} ${entry.path} (${note})`)
    }
    console.log(`共 ${entries.length} 个差异条目`)
    console.log('--check：未写入任何东西')
    return
  }

  // 2. 第一段：推内容。
  //
  // ⚠️ 推送**之前**先记下远端 catalog 的现值：这是降级路径唯一的真相来源。
  // 推完再读就晚了 —— 读到的会是刚推上去的我们自己那份内容。
  const baselineRevision = await readRemoteCatalogRevision()
  const message = messageFile !== undefined
    ? fs.readFileSync(messageFile, 'utf8')
    : `chore(fork): 同步本地内容

本地 HEAD ${localHead.slice(0, 7)}；远端基线 ${remoteSha.slice(0, 7)}。
由 scripts/api-push-squash.mjs 生成：内容与本地逐字节一致，历史压扁，
完整提交历史在本地仓库。`
  const pushed = await pushOneCommit({ baseSha: remoteSha, message })
  if (pushed === null) {
    console.log('✅ 无差异条目')
    return
  }
  const pushedSha = pushed.sha
  console.log(`✅ 远端 ${BRANCH} -> ${pushedSha.slice(0, 7)}（共 ${calls} 次 API 调用）`)

  /**
   * ## 第二段：把 catalog 的 revision 指向**远端真相**
   *
   * ### 为什么必须推两次（真实故障，2026-10-19 release-sign run 39244615254）
   *
   * catalog 的 `source.revision` 必须是「最后一次触碰发布内容的提交」。
   * squash 推送后远端多出的是**新**提交，而本地记录的是本地 commit ——
   * 那个 sha 在远端**根本不存在**（实测 `GET /git/commits/<local>` → 404）。
   * 于是 `main` 上的 `release-sign.yml` 触发后：
   *
   *   - `build-manifest --check` **通过**（字节一致）⇒ 刷新分支不进入；
   *   - 紧接着 release 套件的 `catalog-test` 报
   *     `source revision ... got "<local>", want "<remote>"` ⇒ 红。
   *
   * ### ⚠️ 但「刚推上去的提交」也不是答案（2026-10-20 云端正式跑，第二次撞）
   *
   * 第一段 squash 出来的提交里，如果**发布内容**（`package.json` + `files`）
   * 已经没变（例如上游只改了 README），那「最后触碰发布内容的提交」就不是
   * 它，而是**更早**的某个提交。把 `pushedSha` 一律当 revision 写进去，
   * 等于把一个不碰发布内容的提交说成「最后触碰发布内容的提交」。
   *
   * 所以 revision 必须由 {@link resolveRemoteRevision} 决定：**远端分支上
   * 重算**（与 `catalog-test` 同一算法），拿不到时才按「这次动没动发布内容」
   * 走 API 判据。绝不猜。
   *
   * 第二段只改 `catalog/` 与 `feed/`，不移动 revision 指针本身（该指针只统计
   * 发布内容），所以不会循环 —— 写完再自证一次。
   */
  const resolved = await resolveRemoteRevision({
    pushedSha,
    touchedReleaseContent: pushed.touchedReleaseContent,
    baselineRevision,
  })
  const revision = resolved.revision
  const changed = refreshCatalogRevision(revision)
  if (!changed) {
    console.log('✅ catalog revision 已指向远端真相，无需第二段推送')
    return
  }
  console.log(`第二段：推送刷新后的 catalog（revision → ${revision.slice(0, 7)}）…`)
  const second = await pushOneCommit({
    baseSha: pushedSha,
    message: `catalog: refresh revision over ${revision.slice(0, 7)}`,
  })
  if (second === null) {
    console.log('✅ 第二段无差异（revision 已是目标值）')
    return
  }
  console.log(`✅ 远端 ${BRANCH} -> ${second.sha.slice(0, 7)}（两段推送完成）`)

  /**
   * 自证：写完的值必须等于**远端重算值**。
   *
   * 这是「不再靠人工纠偏」的落地点 —— 不一致就在这里红，而不是推出去让
   * `release-sign.yml` 用 `got/want` 报出来、再靠人手动改 catalog。
   */
  if (second.touchedReleaseContent) {
    // 第二段理论上只动 catalog/feed；真动了发布内容说明有别的差异混进来了，
    // 此时 revision 必然已经过期 ⇒ 直接报错，不留下一个说谎的发布。
    throw new Error('第二段推送意外改动了发布内容，revision 已失效（应只有 catalog/feed 变更）')
  }
  let verified
  if (resolved.source === 'remote' && !gitTransportUnavailable) {
    try {
      verified = remoteContentRevision(BRANCH, { root, attempts: 1, timeout: 20_000 })
    } catch (error) {
      gitTransportUnavailable = true
      console.log(`⚠️ 推送后自证跳过（git fetch 不可用：${String(error.message).split('\n')[0]}）`)
      return
    }
  } else {
    // 降级路径下没有远端历史可算 ⇒ 自证退化为「本地写进去的值 == 远端刚推的内容」
    // 这一条由第二段的 `touchedReleaseContent` 检查兜住（第二段只该动 catalog/feed）。
    console.log(`⚠️ 推送后自证跳过（git 传输不可用 ⇒ revision 取自 ${resolved.source} 判据）`)
    return
  }
  const recorded = catalogRevision({ root })
  if (recorded !== verified) {
    throw new Error(
      `catalog revision 与远端真相不一致：catalog 写的是 ${String(recorded).slice(0, 7)}，`
      + `远端 ${BRANCH} 重算得到 ${verified.slice(0, 7)}`,
    )
  }
  console.log(`✅ 自证通过：远端 ${BRANCH} 的 revision = ${verified.slice(0, 7)}`)
}

/**
 * 用 `set-catalog-revision.mjs` 把两处 revision 写成给定 sha。
 *
 * @returns 是否真的改了文件（没变就不需要第二段推送）。
 */
function refreshCatalogRevision(revision) {
  // ⚠️ ESM 里没有 `require` —— 原来写 `const { execFileSync } = require(...)`
  // 会直接抛 `require is not defined`（本文件顶部已 import execFileSync）。
  const before = git('diff', '--name-only').trim()
  execFileSync('node', ['scripts/set-catalog-revision.mjs', revision], { cwd: root, stdio: 'inherit' })
  const after = git('diff', '--name-only').trim()
  return before !== after
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
