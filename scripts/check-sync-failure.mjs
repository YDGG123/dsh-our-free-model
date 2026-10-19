/**
 * 本机通知桥：读 fork 上的「云端同步失败」状态文件，有新的失败就弹 macOS 通知。
 *
 * ## 为什么是这个形状（而不让云端回调本机）
 *
 * 用户选题：云端失败 → 写状态文件 → 本机轮询 → 系统通知。单向、无回调、
 * 凭据最少暴露：
 *
 * - 云端只需要**写**一个文件（repo 写权限）；
 * - 本机只需要**读**（公开仓库甚至连 token 都不需要）；
 * - 本机不需要对外暴露任何端口或 webhook。
 *
 * ## 去重（避免每天重复弹同一条）
 *
 * 状态文件每次失败都会被覆写。本机记下「已通知过的失败指纹」
 * （`failedAt` + `failedStep` + 冲突文件数），只有指纹变化才弹。
 * 记在 `.private/sync-notify-state.json`（机器状态，不入库）。
 *
 * ## 调用方式
 *
 *     node scripts/check-sync-failure.mjs            # 检查并按需弹通知
 *     node scripts/check-sync-failure.mjs --dry-run   # 只打印，不弹、不写状态
 *     node scripts/check-sync-failure.mjs --force     # 忽略去重，无条件弹一次
 *
 * 由 launchd 在同步任务之后调用（见 docs/verification/2026-10-19-cloud-sync.md）。
 *
 * 退出码：0 = 正常（无论有无失败、是否弹过通知）；1 = 检查本身出错
 *（网络/解析）—— 让 launchd 的日志能显示出来，但**不弹**「检查失败」，
 * 避免把「读不到」误报成「同步失败」。
 *
 * @module scripts/check-sync-failure.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const statePath = path.join(root, '.private', 'sync-notify-state.json')

/** 与 `report-sync-failure.mjs` 的约定保持一致（两边引用同一常量名）。 */
export const SYNC_FAILURE_PATH = '.private/sync-failure.json'
export const SYNC_FAILURE_BRANCH = 'sync-failure'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const force = argv.includes('--force')

/**
 * 计算一次失败的「指纹」。
 *
 * 只用**稳定的字段**：`runId`/`runUrl` 每次都变（同一次失败重跑会不同），
 * 放进指纹会导致同一条失败重复弹。
 */
export function failureFingerprint(payload) {
  const failedAt = typeof payload?.failedAt === 'string' ? payload.failedAt : ''
  const step = typeof payload?.failedStep === 'string' ? payload.failedStep : 'unknown'
  const files = Array.isArray(payload?.conflictedFiles) ? payload.conflictedFiles.length : 0
  return `${failedAt}#${step}#${files}`
}

/** 通知文案（中文，短。系统通知空间有限）。 */
export function notificationText(payload) {
  const step = describeStep(payload?.failedStep)
  const files = Array.isArray(payload?.conflictedFiles) ? payload.conflictedFiles : []
  const detail = files.length > 0
    ? `${files.length} 个文件冲突：${files.slice(0, 3).join('、')}${files.length > 3 ? ' 等' : ''}`
    : (typeof payload?.message === 'string' && payload.message.length > 0 ? payload.message.slice(0, 120) : '')
  return {
    title: '上游同步失败',
    message: `${step}${detail === '' ? '' : ` — ${detail}`}`,
    url: typeof payload?.runUrl === 'string' ? payload.runUrl : '',
  }
}

function describeStep(step) {
  switch (step) {
    case 'merge-conflict': return '合并冲突'
    case 'test-failed': return '回归测试未通过'
    case 'sign-failed': return '签名失败'
    case 'build-failed': return '构建失败'
    case 'push-failed': return '推送失败'
    default: return '未知步骤'
  }
}

/** 读远端状态文件。公开仓库不需要 token；有 token 时用它避开限流。 */
export async function fetchFailureState({
  owner = 'YDGG123',
  repo = 'dsh-our-free-model',
  branch = SYNC_FAILURE_BRANCH,
  path: filePath = SYNC_FAILURE_PATH,
  token = '',
  fetchImpl = fetch,
} = {}) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`
  const headers = { 'user-agent': 'ofm-check-sync-failure' }
  if (token !== '') headers.authorization = `Bearer ${token}`
  const response = await fetchImpl(url, { headers })
  // 404 = 从未失败过（或该分支还没建），这是正常状态，不是错误。
  if (response.status === 404) return { exists: false, payload: null }
  if (!response.ok) throw new Error(`读取状态文件失败：HTTP ${response.status}`)
  const text = await response.text()
  if (text.trim() === '') return { exists: false, payload: null }
  return { exists: true, payload: JSON.parse(text) }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch { return {} }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

/** macOS 系统通知。非 macOS 或 osascript 不可用时退化为打印（不失败）。 */
export function notify({ title, message, url }, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'darwin') {
    console.log(`[notify:${platform}] ${title}: ${message}${url === '' ? '' : ` (${url})`}`)
    return { shown: false, reason: 'not-macos' }
  }
  // osascript 的字符串字面量：先转义反斜杠与双引号，避免用户内容里的引号
  // 把脚本提前闭合（冲突文件名可能含引号）。
  const quote = value => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  const script = `display notification "${quote(message)}" with title "${quote(title)}"`
  const result = run('osascript', ['-e', script], { encoding: 'utf8' })
  if (result.status !== 0) {
    // 通知失败不该让检查流程变红：把原因打到日志即可。
    console.log(`⚠️ 通知弹出失败（${result.status}）：${(result.stderr ?? '').slice(0, 200)}`)
    return { shown: false, reason: 'osascript-failed' }
  }
  return { shown: true }
}

/**
 * 是否被直接执行。
 *
 * ⚠️ **不能用** `` `file://${process.argv[1]}` `` 拼接：`import.meta.url` 里的
 * 路径是**百分号编码**的（空格 → `%20`），而本仓库路径正好含空格
 *（`/Volumes/办公/IDM下载/…`）⇒ 两者永不相等，脚本会静默什么都不做。
 * 必须用 `pathToFileURL` 归一。
 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    const token = process.env.GH_TOKEN ?? (fs.existsSync(path.join(root, '.private', 'gh-token'))
      ? fs.readFileSync(path.join(root, '.private', 'gh-token'), 'utf8').trim()
      : '')
    const state = await fetchFailureState({ token })
    if (!state.exists) {
      console.log('check-sync-failure: 云端无同步失败记录')
      process.exitCode = 0
    } else {
      const payload = state.payload
      const fingerprint = failureFingerprint(payload)
      const previous = readState()
      const seen = previous.lastNotifiedFingerprint === fingerprint
      const text = notificationText(payload)
      if (dryRun) {
        console.log(JSON.stringify({ fingerprint, alreadyNotified: seen, ...text }, null, 2))
        process.exitCode = 0
      } else if (seen && !force) {
        console.log(`check-sync-failure: 这条失败已通知过（${fingerprint}），跳过`)
        process.exitCode = 0
      } else {
        notify(text)
        writeState({ lastNotifiedFingerprint: fingerprint, lastNotifiedAt: new Date().toISOString() })
        console.log(`check-sync-failure: 已通知 — ${text.title}：${text.message}`)
        process.exitCode = 0
      }
    }
  } catch (error) {
    console.error(`check-sync-failure: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
