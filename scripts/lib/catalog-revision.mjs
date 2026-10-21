/**
 * 「发布内容的最后触碰提交」——**唯一**实现。
 *
 * ## 这条口径为什么必须只有一个实现
 *
 * catalog 里两处 revision（`catalog/dsh-plugin.json` 的 `source.revision`、
 * `catalog/provenance.json` 的 `subject.sourceRevision`）必须等于
 * **最后一次触碰发布内容的提交**。判据由 `scripts/catalog-test.mjs` 校验：
 *
 *     git log -1 --format=%H -- package.json <pkg.files...>
 *
 * 2026-10-19 / 10-20 连续踩了三次同一个坑，每次都是「在**别的**对象上算」：
 *
 * 1. 用**本地 HEAD** 算 ⇒ squash 推送后在远端根本不存在（`GET /git/commits/<local>`
 *    返回 404），release-sign 报 `got "<local>", want "<remote>"`；
 * 2. 用**推送后的 HEAD** 算 ⇒ 那个提交只碰了 `catalog/`，真正碰发布内容的是它
 *    前面的产物重建提交（`c85e27e` vs `b005cb2`），写进去当场就是错值；
 * 3. 用**推送前的 sha** 算 ⇒ 同上，只是换了时机。
 *
 * 唯一正确的对象是**远端分支上**的那个提交。所以本模块只做一件事：
 *
 *     fetch 远端分支 → 在该 ref 上跑 catalog-test 的同一条 git log
 *
 * 目标分支由调用方给出（云端是 `custom-main` / `main`，本机是 `main`）。
 *
 * ## 为什么 catalog-test 不 import 这个模块
 *
 * 那个文件是**校验者**。让它和写入方共用同一份实现，等于用同一句话既写题又
 * 判卷 —— 实现错了会一起错，测试永远是绿的。它保留自己那份独立实现，正是
 * 为了让本模块的 bug 能被它抓住。
 *
 * @module scripts/lib/catalog-revision.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（本文件在 `scripts/lib/` 下）。 */
export const REPO_ROOT = path.join(fileURLToPath(new URL('../..', import.meta.url)))

/** Git 的完整 sha 形态。短 sha / 大写 / 空串都必须被拒绝。 */
export const SHA_PATTERN = /^[0-9a-f]{40}$/

/** fetch 远端分支的超时。超时就抛错，由调用方决定「降级」还是「拒绝写入」。 */
const FETCH_TIMEOUT_MS = 60_000

/**
 * fetch 尝试次数。
 *
 * ⚠️ 本机网络对 github 的 git 传输是**间歇性**可用的：实测同一分钟内
 * `Error in the HTTP2 framing layer` 与成功交替出现，而单次失败要等两分钟
 * 才超时。一次失败就整条发布降级到「API 判据」代价太大 —— 那里拿不到真实
 * 的提交历史。重试几次的总代价远小于一次错误的降级。
 *
 * 可注入 `attempts` 供测试缩短（真实路径不传，用这个默认值）。
 */
const FETCH_ATTEMPTS = 3

/**
 * 发布内容的路径清单：`package.json` + 它的 `files` 列表。
 *
 * ⚠️ 绝不在这里手写路径。手写清单会与 `package.json.files` 漂移，而在
 * `package.json` 里加一个新目录后，revision 会指向错误的提交 —— 且只有
 * release 模式的 `catalog-test` 才会报出来。
 *
 * @param {{ files?: string[] }} pkg 已解析的 package.json
 * @returns {string[]}
 */
export function releaseContentPaths(pkg) {
  return ['package.json', ...(pkg.files ?? [])]
}

/**
 * 从仓库里读出 `package.json` 并给出发布内容路径。
 *
 * 读不到就抛**能照做**的错误：没有 `package.json` 意味着这压根不是发布仓库
 * （或工作目录跑偏了），此时继续往下算只会得到一个更莫名其妙的失败。
 *
 * @param {{ root?: string }} [options]
 * @returns {string[]}
 */
export function readReleaseContentPaths(options = {}) {
  const root = options.root ?? REPO_ROOT
  const file = path.join(root, 'package.json')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`读不到 ${file}，无法确定发布内容清单（${error?.message ?? error}）`)
  }
  let pkg
  try {
    pkg = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${file} 不是合法 JSON，无法确定发布内容清单（${error?.message ?? error}）`)
  }
  return releaseContentPaths(pkg)
}

/**
 * 在**指定 ref** 上求「最后一次触碰发布内容的提交」。
 *
 * @param {string} ref 任意 git 可解析的 ref（`HEAD`、`origin/main`、40 位 sha …）
 * @param {{ root?: string, paths?: string[] }} [options]
 * @returns {string} 40 位 sha
 * @throws 当 git 不可用或该 ref 上发布内容没有提交时抛错（**绝不返回猜测值**）
 */
export function contentRevisionAt(ref, options = {}) {
  const root = options.root ?? REPO_ROOT
  const paths = options.paths ?? readReleaseContentPaths({ root })
  let out
  try {
    out = execFileSync('git', ['log', '-1', '--format=%H', ref, '--', ...paths], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim()
  } catch (error) {
    throw new Error(`无法在 ${ref} 上遍历发布内容的提交历史（${error?.message ?? error}）`)
  }
  if (!SHA_PATTERN.test(out)) {
    throw new Error(`${ref} 上找不到发布内容的提交（git log 返回 "${out}"），拒绝写入猜测值`)
  }
  return out
}

/**
 * 把远端分支抓成本地 remote-tracking ref（`refs/remotes/<remote>/<branch>`）。
 *
 * 显式写 refspec（而不是 `git fetch origin <branch>`）的理由：后者的更新目标
 * 取决于 fetch 配置，遇到 `remote.origin.fetch` 被改写时会只更新 `FETCH_HEAD`
 * 而不更新 `origin/<branch>` —— 我们就又回到「算在一个陈旧 ref 上」。
 *
 * @returns {string} 可传给 {@link contentRevisionAt} 的 ref
 */
export function fetchRemoteBranch(branch, options = {}) {
  const root = options.root ?? REPO_ROOT
  const remote = options.remote ?? 'origin'
  const attempts = options.attempts ?? FETCH_ATTEMPTS
  const timeout = options.timeout ?? FETCH_TIMEOUT_MS
  const ref = `refs/remotes/${remote}/${branch}`
  let lastDetail = ''
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      execFileSync('git', ['fetch', '--force', '--no-tags', remote, `${branch}:${ref}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout,
        maxBuffer: 64 * 1024 * 1024,
      })
      return `${remote}/${branch}`
    } catch (error) {
      lastDetail = `${error?.stderr ?? ''}${error?.message ?? error}`.trim().split('\n').slice(-3).join(' | ')
      if (attempt < attempts) {
        // 退避：网络抖动通常几秒内自愈。用 Atomics.wait 同步睡（本模块是
        // 同步 API，不能 await；也不去 spawn 一个 `sleep` 进程）。
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt)
      }
    }
  }
  throw new Error(`fetch ${remote}/${branch} 失败（重试 ${attempts} 次），无法确认远端 revision：${lastDetail}`)
}

/**
 * **在远端分支上**重算 revision —— 这就是写进 catalog 的唯一正确值。
 *
 * 调用时机：内容推送**之后**、写 catalog **之前**。fetch 而不是信任本地
 * remote-tracking ref：`git push` 虽然通常会顺手更新它，但那是实现细节，
 * 而且云端 `release-sign.yml` 可能刚推过一个提交（竞态）。
 *
 * @param {string} branch 远端分支名（`main` / `custom-main`）
 * @param {{ root?: string, remote?: string, paths?: string[] }} [options]
 * @returns {string} 40 位 sha
 */
export function remoteContentRevision(branch, options = {}) {
  const ref = fetchRemoteBranch(branch, options)
  return contentRevisionAt(ref, options)
}

/**
 * **真查询**远端分支上「发布内容的最后触碰提交」（GitHub REST API）。
 *
 * ## 为什么需要它（真实缺陷，2026-10-21 真机推送 2.5.7）
 *
 * `remoteContentRevision()` 依赖 `git fetch`，而这台机器到 `github.com:443`
 * 的 git 传输是被阻断的。于是本机走的全是「靠 diff 推断」的降级路径，而推断在
 * **投影提交自身改了发布内容**（2.5.7 删渠道 ⇒ `package.json` / `client.js` /
 * `pack.js` 全变）时说不出「远端哪个提交才是答案」。
 *
 * 这里的查询与 `git log -1 -- <paths>` 语义一致：对每个发布内容路径各问一次
 * 「该分支上最后碰它的是谁」，再在候选之间用 compare 求**祖先关系**定序
 * （不靠提交日期 —— 时钟偏移/改写会让日期序与拓扑序不一致）。
 *
 * ## 顺序为什么要用 compare 而不是「取第一个」
 *
 * 多个路径的「各自最后触碰提交」通常不是同一个（一次发版动 `client.js`、
 * 下一次只动 `package.json`）。取任意一个都可能选到**更旧**的那个，
 * 于是又写错值。compare 会明确回答谁在谁前面；一旦出现 `diverged`
 * （无法定序）**直接报错**，绝不在这种情况下猜。
 *
 * @param {{ branch: string, owner: string, repo: string, token: string,
 *           paths?: string[], fetchImpl?: typeof fetch }} options
 * @returns {Promise<string>} 40 位 sha
 */
export async function fetchRemoteReleaseRevision(options) {
  const {
    branch, owner, repo, token,
    paths = readReleaseContentPaths({ root: options.root }),
    fetchImpl = fetch,
  } = options
  if (typeof branch !== 'string' || branch === '') throw new Error('fetchRemoteReleaseRevision 需要 branch')
  if (typeof owner !== 'string' || typeof repo !== 'string' || owner === '' || repo === '') {
    throw new Error('fetchRemoteReleaseRevision 需要 owner / repo')
  }
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'ofm-catalog-revision',
  }
  const get = async (endpoint) => {
    const response = await fetchImpl(`${apiBase}${endpoint}`, { headers })
    if (!response.ok) {
      throw new Error(`GET ${endpoint} -> HTTP ${response.status}（无法确认远端 revision）`)
    }
    return response.json()
  }

  const candidates = []
  for (const filePath of paths) {
    const list = await get(`/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(filePath)}&per_page=1`)
    if (Array.isArray(list) && list.length > 0 && typeof list[0]?.sha === 'string') candidates.push(list[0].sha)
  }
  const unique = [...new Set(candidates)]
  if (unique.length === 0) {
    throw new Error(`远端 ${branch} 上找不到触碰发布内容的提交（查询了 ${paths.length} 个路径）`)
  }
  if (unique.length === 1) return unique[0]

  // 多个候选：逐个用 compare 定序，取「所有其他候选都是它祖先」的那个。
  let best = unique[0]
  for (const other of unique.slice(1)) {
    const { status } = await get(`/compare/${other}...${best}`)
    if (status === 'ahead' || status === 'identical') continue // best 更新（或同一个提交）
    if (status === 'behind') { best = other; continue } // other 更新
    throw new Error(
      `无法确定 ${branch} 上哪个提交是最新（compare ${other.slice(0, 7)}...${best.slice(0, 7)} 返回 ${status}）——`
      + '拒绝猜测，请人工确认',
    )
  }
  return best
}

/**
 * 读 catalog 里当前记录的 revision（`catalog/dsh-plugin.json`）。
 *
 * 只用于**推送后的自证**：远端重算值必须等于我们刚写进去的值，否则宁可
 * 报错也不留一个「以为对了」的发布。
 *
 * @param {{ root?: string }} [options]
 * @returns {string|undefined}
 */
export function catalogRevision(options = {}) {
  const root = options.root ?? REPO_ROOT
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'catalog', 'dsh-plugin.json'), 'utf8'))
    return doc?.source?.revision
  } catch {
    return undefined
  }
}

/** 该路径是否属于发布内容（用于「这次推送到底动没动发布内容」的判断）。 */
export function isReleaseContentPath(filePath, paths) {
  return paths.some(entry => filePath === entry || filePath.startsWith(`${entry}/`))
}
