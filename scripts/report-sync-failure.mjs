/**
 * 把「上游同步失败」的状态文件写进 fork 的 `sync-failure` 分支。
 *
 * ## 为什么走 API 提交、而不是 git push
 *
 * 云端 workflow 刚跑完一轮同步（可能已经推送过 main），此时工作区状态复杂。
 * 用 Contents API 直接向**另一个分支**写一个文件，不切换分支、不动工作区，
 * 也不会与主流程的 push 竞态。
 *
 * ## 为什么单独一个文件
 *
 * 原先这段内联在 workflow 的 shell 里（三层引号 + base64 + node -e），
 * 既没法单测也没法本地复现。抽出来后：workflow 只调一行，本地可用
 * `--file` 直接验证，读取方（`scripts/check-sync-failure.mjs`）也能共用
 * 同一份字段约定。
 *
 * ## 用法
 *
 *     node scripts/report-sync-failure.mjs --file <path> [--branch sync-failure]
 *
 * 需要环境变量 `GH_TOKEN`（repo 写权限）。`--dry-run` 只打印将要提交的内容。
 *
 * @module scripts/report-sync-failure.mjs
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

/** 失败状态文件在 fork 里的路径（与读取方约定，两边都从这里引用）。 */
export const SYNC_FAILURE_PATH = '.private/sync-failure.json'
/** 存放状态文件的独立分支（不污染 main 的历史）。 */
export const SYNC_FAILURE_BRANCH = 'sync-failure'

/**
 * 归一化失败信息，保证读取方拿到的字段永远齐全。
 *
 * 缺字段时用**明确的占位**而不是 `undefined`：本机通知桥要直接把它们拼进
 * 文案里，缺字段会让通知显示成「undefined 个文件冲突」。
 */
export function normalizeFailure(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  const conflicted = Array.isArray(source.conflictedFiles) ? source.conflictedFiles.filter(x => typeof x === 'string') : []
  return {
    failedAt: typeof source.failedAt === 'string' && source.failedAt.length > 0
      ? source.failedAt
      : new Date().toISOString(),
    failedStep: typeof source.failedStep === 'string' && source.failedStep.length > 0
      ? source.failedStep
      : 'unknown',
    message: typeof source.message === 'string' ? source.message : '',
    upstreamHead: typeof source.upstreamHead === 'string' ? source.upstreamHead : '',
    preMergeHead: typeof source.preMergeHead === 'string' ? source.preMergeHead : '',
    conflictedFiles: conflicted,
    runUrl: typeof source.runUrl === 'string' ? source.runUrl : '',
  }
}

/** 失败步骤 → 给人看的中文短语（通知文案用它）。 */
export function describeFailureStep(step) {
  switch (step) {
    case 'merge-conflict': return '合并冲突'
    case 'test-failed': return '回归测试未通过'
    case 'sign-failed': return '签名失败'
    case 'build-failed': return '构建失败'
    case 'push-failed': return '推送失败'
    default: return '未知步骤'
  }
}

/**
 * 写状态文件到 fork。
 *
 * @returns {Promise<{ ok: boolean, status: number, message: string }>}
 */
export async function reportSyncFailure({
  payload,
  token,
  owner,
  repo,
  branch = SYNC_FAILURE_BRANCH,
  /** 新建分支时用哪个分支的 HEAD 作为起点。 */
  baseBranch = 'main',
  path = SYNC_FAILURE_PATH,
  fetchImpl = fetch,
}) {
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'ofm-report-sync-failure',
  }
  // 幂等：分支上已有该文件时必须带 sha，否则 API 返回 422。
  let sha
  try {
    const existing = await fetchImpl(`${api}?ref=${branch}`, { headers })
    if (existing.ok) {
      const body = await existing.json()
      if (typeof body?.sha === 'string') sha = body.sha
    }
  } catch { /* 读不到 = 首次写入，忽略 */ }

  /**
   * ⚠️ **分支不存在时 Contents API 不会自动创建它**（真实故障，2026-10-19
   * run 39246861262）：PUT 直接返回
   * `404 Branch sync-failure not found` —— 而这条 404 很容易被误读成
   * 「token 没权限」，实际只是分支还没建。
   *
   * 故先确保分支存在：拿 `baseBranch`（默认 `main`）的 HEAD 建一个新 ref。
   * 已存在时 422（"Reference already exists"），那是正常情况，忽略即可。
   */
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`
  const ensured = await ensureBranch({ fetchImpl, headers, branch, baseBranch, apiBase })
  // 建分支失败不立即返回：仍试一次 PUT（也许分支其实已存在、只是探测被限流）。
  // 但把原因带进最终错误里，否则「404 Branch not found」会让人以为是权限问题。

  const body = {
    message: 'chore(sync): record upstream sync failure',
    content: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`).toString('base64'),
    branch,
    ...sha === undefined ? {} : { sha },
  }
  const response = await fetchImpl(api, { method: 'PUT', headers, body: JSON.stringify(body) })
  const text = await response.text()
  /**
   * 兜底：即便上面已建分支，仍可能撞到 404（分支刚被删 / 并发）。再试一次，
   * 仍失败就如实返回 —— 通知链路宁可有明确错误，也不要静默成功。
   */
  if (response.status === 404) {
    const retried = await ensureBranch({ fetchImpl, headers, branch, baseBranch, apiBase })
    if (retried.ok) {
      const again = await fetchImpl(api, { method: 'PUT', headers, body: JSON.stringify(body) })
      const againText = await again.text()
      return {
        ok: again.ok,
        status: again.status,
        message: again.ok ? 'written' : againText.slice(0, 300),
      }
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    message: response.ok
      ? 'written'
      : `${text.slice(0, 300)}${ensured.ok ? '' : `（分支准备失败：${ensured.reason ?? '未知'}）`}`,
  }
}

/**
 * 确保目标分支存在（不存在就从 `baseBranch` 的 HEAD 建一个）。
 *
 * 只做两件事，直白、可测：
 * 1. `GET /git/ref/heads/<branch>` —— 存在就返回；
 * 2. 不存在 ⇒ `POST /git/refs` 用 base 分支的 sha 建；422（已存在）也算成。
 *
 * @returns `{ ok: boolean, created: boolean, reason?: string }`
 */
export async function ensureBranch({ fetchImpl, headers, branch, baseBranch, apiBase }) {
  const refUrl = name => `${apiBase}/git/ref/heads/${name}`
  // ① 目标分支已在？
  const existing = await fetchImpl(refUrl(branch), { headers })
  if (existing.ok) return { ok: true, created: false }
  if (existing.status !== 404) {
    return { ok: false, created: false, reason: `探测分支失败：HTTP ${existing.status}` }
  }
  // ② 取 base 分支的 sha 作为起点
  const base = await fetchImpl(refUrl(baseBranch), { headers })
  if (!base.ok) {
    return { ok: false, created: false, reason: `取 ${baseBranch} 的 HEAD 失败：HTTP ${base.status}` }
  }
  const sha = (await base.json())?.object?.sha
  if (typeof sha !== 'string' || sha.length === 0) {
    return { ok: false, created: false, reason: `${baseBranch} 没有可用的 HEAD sha` }
  }
  // ③ 建分支
  const create = await fetchImpl(`${apiBase}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  })
  // 422 = 已存在（并发场景），同样可用。
  if (create.ok || create.status === 422) return { ok: true, created: create.ok }
  return { ok: false, created: false, reason: `建分支失败：HTTP ${create.status}` }
}
/**
 * 清除 fork 上的失败状态文件（同步成功后调用）。
 *
 * ## 为什么必须清（真实缺陷，2026-10-20）
 *
 * 状态文件每次失败都被**覆写**，但**成功时没人删它** ⇒ 本机通知桥永远读到
 * 那条旧失败，于是「今天同步明明成功了，却在弹昨天的 esbuild 失败」。
 * 通知说反了比不通知更糟：用户会去排查一个已经不存在的问题。
 *
 * 删除走 Contents API（`DELETE /contents/<path>`，需带当前 `sha`）。
 * 分支/文件不存在（404）是**正常情况**（从未失败过），不算错误。
 *
 * @returns `{ ok: boolean, deleted: boolean, reason?: string }`
 *   `deleted: false` 且 `ok: true` = 本来就没有失败记录。
 */
export async function clearSyncFailure({
  token,
  owner,
  repo,
  branch = SYNC_FAILURE_BRANCH,
  path = SYNC_FAILURE_PATH,
  message = 'chore(sync): clear upstream sync failure (the run succeeded)',
  fetchImpl = fetch,
}) {
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'ofm-clear-sync-failure',
  }
  let sha
  try {
    const existing = await fetchImpl(`${api}?ref=${branch}`, { headers })
    /**
     * ⚠️ **只有 404 才算「没有失败记录」**。
     *
     * 其它非 2xx（401 token 失效 / 403 无权限 / 5xx 上游抖动）必须**报错**——
     * 否则「清除失败」会被静默当成「本来就没有」，于是旧失败记录永远留着，
     * 通知桥继续弹过期消息（正是本次要修的缺陷的翻版）。
     */
    if (existing.status === 404) return { ok: true, deleted: false }
    if (!existing.ok) {
      return { ok: false, deleted: false, reason: `读取状态文件失败：HTTP ${existing.status}` }
    }
    const body = await existing.json()
    if (typeof body?.sha === 'string') sha = body.sha
  } catch (error) {
    return { ok: false, deleted: false, reason: `读取状态文件失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (sha === undefined) return { ok: true, deleted: false }
  const response = await fetchImpl(api, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ message, sha, branch }),
  })
  if (response.ok) return { ok: true, deleted: true }
  const text = await response.text()
  return { ok: false, deleted: false, reason: `删除失败：HTTP ${response.status} ${text.slice(0, 200)}` }
}

/** 清除失败状态的 CLI 入口（workflow 成功路径调用）。 */
export async function clearSyncFailureCli(argv = process.argv.slice(2)) {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? 'YDGG123/dsh-our-free-model').split('/')
  const token = process.env.GH_TOKEN ?? ''
  if (token === '') throw new Error('需要环境变量 GH_TOKEN（repo 写权限）')
  const result = await clearSyncFailure({ token, owner, repo })
  return result
}

/**
 * 是否被直接执行。用 `pathToFileURL` 而不是字符串拼接：本仓库路径含空格，
 * 手工拼 `file://` 会与 `import.meta.url` 的百分号编码形式不相等
 *（同类坑见 `check-sync-failure.mjs` 的注释）。
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const flag = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }
  const file = flag('file')
  const dryRun = argv.includes('--dry-run')
  const clear = argv.includes('--clear')
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? 'YDGG123/dsh-our-free-model').split('/')
  try {
    /**
     * `--clear`：同步成功时清除失败记录（见 {@link clearSyncFailure} 的说明）。
     *
     * 放在这里而不是另写脚本：两者共用同一份路径/分支常量与鉴权约定，
     * 分开写必然漂移（本项目已吃过「两份清单漂移」的亏）。
     */
    if (clear) {
      const cleared = await clearSyncFailureCli()
      if (!cleared.ok) throw new Error(cleared.reason ?? '清除失败记录失败')
      console.log(cleared.deleted
        ? 'report-sync-failure: 已清除失败记录（本次同步成功）'
        : 'report-sync-failure: 没有失败记录需要清除')
      process.exitCode = 0
    } else {
    const parsed = file === undefined ? {} : JSON.parse(fs.readFileSync(file, 'utf8'))
    const payload = normalizeFailure(parsed)
    if (dryRun) {
      console.log(JSON.stringify(payload, null, 2))
      process.exitCode = 0
    } else {
      const token = process.env.GH_TOKEN ?? ''
      if (token === '') throw new Error('需要环境变量 GH_TOKEN（repo 写权限）')
      const result = await reportSyncFailure({ payload, token, owner, repo, branch: flag('branch') ?? SYNC_FAILURE_BRANCH })
      console.log(`report-sync-failure: HTTP ${result.status} ${result.message}`)
      process.exitCode = result.ok ? 0 : 1
    }
    }
  } catch (error) {
    console.error(`report-sync-failure: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
