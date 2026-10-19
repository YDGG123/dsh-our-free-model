/**
 * 云端同步失败「状态文件 ↔ 本机通知」链路的离线回归。
 *
 * ## 覆盖什么
 *
 * 这条链路跨两个进程、两个仓库、外加一个 GitHub API：
 *
 * ```
 * 云端失败 → scripts/report-sync-failure.mjs → fork 的 sync-failure 分支
 *                                                    ↓ (HTTPS 原始文件)
 * 本机 launchd → scripts/check-sync-failure.mjs → osascript 系统通知
 * ```
 *
 * 端到端无法离线跑，但**接缝全是可注入的**（fetch、osascript 的 spawn
 * 替身、状态文件路径），所以这里逐段验证契约：
 *
 * 1. 写：首次写不带 `sha`、重复写带 `sha`（API 要求，漏了就 422）；
 * 2. 缺字段的载荷会被归一化（通知里不能出现 undefined）；
 * 3. 读：404 视为「无失败」（正常状态，不是错误）；
 * 4. 指纹稳定：同一次失败重跑（`runUrl` 变了）不该重复弹；
 * 5. 通知文案：冲突文件清单与步骤都被翻成人话；
 * 6. osascript 字符串转义：冲突文件名里带引号不能把脚本提前闭合。
 *
 * Run: node scripts/cloud-sync-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const report = await import('./report-sync-failure.mjs')
const check = await import('./check-sync-failure.mjs')

let failures = 0
const check_ = (name, run) => {
  try { run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}
const checkAsync = async (name, run) => {
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}

// ── 写：API 契约 ─────────────────────────────────────────────────────────────

await checkAsync('首次写状态文件：不带 sha，落在 sync-failure 分支', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body })
    if ((init.method ?? 'GET') === 'GET') return new Response('{}', { status: 404 })
    return Response.json({ content: { sha: 'abc' } }, { status: 201 })
  }
  const result = await report.reportSyncFailure({
    payload: report.normalizeFailure({ failedStep: 'merge-conflict', conflictedFiles: ['client.js'] }),
    token: 't', owner: 'o', repo: 'r', fetchImpl,
  })
  assert.equal(result.ok, true)
  const put = calls.find(call => call.method === 'PUT')
  const body = JSON.parse(put.body)
  assert.equal(body.branch, 'sync-failure', '状态文件必须放在独立分支，不污染 main')
  assert.equal(body.sha, undefined, '首次写不该带 sha')
  assert.equal(put.url, `https://api.github.com/repos/o/r/contents/${report.SYNC_FAILURE_PATH}`)
  // 内容是 base64 的 JSON，解回来要能读懂。
  const decoded = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))
  assert.equal(decoded.failedStep, 'merge-conflict')
  assert.deepEqual(decoded.conflictedFiles, ['client.js'])
})

await checkAsync('重复写同一文件：必须带 sha（否则 API 422）', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body })
    if ((init.method ?? 'GET') === 'GET') return Response.json({ sha: 'deadbeef' })
    return Response.json({ content: { sha: 'cafe' } }, { status: 200 })
  }
  await report.reportSyncFailure({
    payload: report.normalizeFailure({}), token: 't', owner: 'o', repo: 'r', fetchImpl,
  })
  const put = calls.find(call => call.method === 'PUT')
  assert.equal(JSON.parse(put.body).sha, 'deadbeef', '已有文件时必须带 sha')
})

await checkAsync('写失败时如实返回 ok=false 与状态码', async () => {
  const fetchImpl = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') return new Response('{}', { status: 404 })
    return new Response('{"message":"Resource not accessible by integration"}', { status: 403 })
  }
  const result = await report.reportSyncFailure({
    payload: report.normalizeFailure({}), token: 't', owner: 'o', repo: 'r', fetchImpl,
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 403)
  assert.match(result.message, /not accessible/)
})

// ── 载荷归一化 ───────────────────────────────────────────────────────────────

check_('缺字段的载荷被补齐（通知里不能出现 undefined）', () => {
  const payload = report.normalizeFailure({})
  for (const key of ['failedAt', 'failedStep', 'message', 'upstreamHead', 'preMergeHead', 'runUrl']) {
    assert.equal(typeof payload[key], 'string', `${key} 必须是字符串`)
    assert.notEqual(payload[key], 'undefined')
  }
  assert.deepEqual(payload.conflictedFiles, [])
  assert.equal(payload.failedStep, 'unknown')
})

check_('脏字段被清洗：非字符串的冲突项被剔除', () => {
  const payload = report.normalizeFailure({ conflictedFiles: ['a.js', 42, null, 'b.ts'] })
  assert.deepEqual(payload.conflictedFiles, ['a.js', 'b.ts'])
})

// ── 读：404 是正常态 ─────────────────────────────────────────────────────────

await checkAsync('远端没有状态文件（404）⇒ exists=false，不是错误', async () => {
  const result = await check.fetchFailureState({
    fetchImpl: async () => new Response('404: Not Found', { status: 404 }),
  })
  assert.equal(result.exists, false)
  assert.equal(result.payload, null)
})

await checkAsync('读到状态文件 ⇒ 解析出载荷', async () => {
  const body = JSON.stringify({ failedAt: '2026-10-19T03:17:00Z', failedStep: 'test-failed', conflictedFiles: [] })
  const result = await check.fetchFailureState({ fetchImpl: async () => new Response(body, { status: 200 }) })
  assert.equal(result.exists, true)
  assert.equal(result.payload.failedStep, 'test-failed')
})

await checkAsync('远端 5xx ⇒ 抛错（不能当成「没有失败」）', async () => {
  await assert.rejects(
    check.fetchFailureState({ fetchImpl: async () => new Response('boom', { status: 503 }) }),
    /503/,
  )
})

// ── 去重指纹 ─────────────────────────────────────────────────────────────────

check_('指纹稳定：同一次失败重跑（runUrl 变化）指纹不变', () => {
  const base = {
    failedAt: '2026-10-19T03:17:00Z', failedStep: 'merge-conflict',
    conflictedFiles: ['client.js', 'index.ts'],
  }
  const first = check.failureFingerprint({ ...base, runUrl: 'https://x/1' })
  const rerun = check.failureFingerprint({ ...base, runUrl: 'https://x/2' })
  assert.equal(first, rerun, 'runUrl 每次都不同，放进指纹会导致重复弹')
})

check_('指纹区分：时间/步骤/冲突数任一变化都会变', () => {
  const a = check.failureFingerprint({ failedAt: 't1', failedStep: 'merge-conflict', conflictedFiles: ['a'] })
  assert.notEqual(a, check.failureFingerprint({ failedAt: 't2', failedStep: 'merge-conflict', conflictedFiles: ['a'] }))
  assert.notEqual(a, check.failureFingerprint({ failedAt: 't1', failedStep: 'test-failed', conflictedFiles: ['a'] }))
  assert.notEqual(a, check.failureFingerprint({ failedAt: 't1', failedStep: 'merge-conflict', conflictedFiles: ['a', 'b'] }))
})

// ── 通知文案 ─────────────────────────────────────────────────────────────────

check_('冲突类失败：标题+步骤+前三个文件名', () => {
  const text = check.notificationText({
    failedStep: 'merge-conflict',
    conflictedFiles: ['client.js', 'index.ts', 'a.md', 'b.md'],
  })
  assert.equal(text.title, '上游同步失败')
  assert.match(text.message, /合并冲突/)
  assert.match(text.message, /4 个文件冲突/)
  assert.match(text.message, /client\.js/)
  assert.match(text.message, /等/, '超过三个要显示「等」')
})

check_('测试失败：没有冲突文件时用 message 摘要', () => {
  const text = check.notificationText({ failedStep: 'test-failed', message: '测试失败：scripts/catalog-test.mjs', conflictedFiles: [] })
  assert.match(text.message, /回归测试未通过/)
  assert.match(text.message, /catalog-test/)
})

// ── osascript 转义 ───────────────────────────────────────────────────────────

check_('osascript 脚本正确转义引号与反斜杠（文件名含引号不会破坏脚本）', () => {
  const calls = []
  const run = (file, args) => { calls.push({ file, args }); return { status: 0, stderr: '' } }
  check.notify(
    { title: 'T', message: 'a "quoted" file.js and \\backslash', url: '' },
    { platform: 'darwin', run },
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'osascript')
  const script = calls[0].args[1]
  // 引号必须被转义成 \" —— 否则 display notification 的字符串会提前闭合。
  assert.ok(script.includes('\\"quoted\\"'), `脚本未转义引号：${script}`)
  assert.ok(script.includes('\\\\backslash'), `脚本未转义反斜杠：${script}`)
  // 转义后整体必须是**一个**合法的 osascript 表达式（引号成对）。
  const quotes = (script.match(/(?<!\\)"/g) ?? []).length
  assert.equal(quotes % 2, 0, '转义后引号必须成对')
})

check_('非 macOS 不调 osascript（退化为日志）', () => {
  let called = false
  const result = check.notify(
    { title: 'T', message: 'm', url: '' },
    { platform: 'linux', run: () => { called = true; return { status: 0 } } },
  )
  assert.equal(called, false)
  assert.equal(result.shown, false)
  assert.equal(result.reason, 'not-macos')
})

check_('osascript 失败不抛错（通知失败不该让检查流程变红）', () => {
  const result = check.notify(
    { title: 'T', message: 'm', url: '' },
    { platform: 'darwin', run: () => ({ status: 1, stderr: 'not authorized' }) },
  )
  assert.equal(result.shown, false)
  assert.equal(result.reason, 'osascript-failed')
})

// ── 状态文件往返（真实文件系统） ─────────────────────────────────────────────

check_('真实文件往返：写状态文件 → 读回 → 指纹一致', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-notify-'))
  const file = path.join(dir, 'sync-failure.json')
  const payload = report.normalizeFailure({
    failedAt: '2026-10-19T03:17:00Z', failedStep: 'merge-conflict', conflictedFiles: ['client.js'],
  })
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  const readBack = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(check.failureFingerprint(readBack), check.failureFingerprint(payload))
})

// ── 直接执行守卫（真实缺陷：本仓库路径含空格） ──────────────────────────────

await checkAsync('两个脚本的「是否直接执行」判定在含空格路径下仍然成立', async () => {
  // 真实缺陷（2026-10-19 本任务踩到）：`import.meta.url` 里的路径是百分号编码的，
  // 而本仓库路径含空格（/Volumes/办公/IDM下载/…）。用 `` `file://${argv[1]}` ``
  // 手工拼会**永不相等** ⇒ 脚本静默什么都不做（又一次假绿灯）。
  const { pathToFileURL } = await import('node:url')
  const sample = '/Volumes/办公/IDM下载/Our Free Model/dsh-our-free-model/scripts/check-sync-failure.mjs'
  assert.notEqual(`file://${sample}`, pathToFileURL(sample).href, '手工拼接与 pathToFileURL 必须不同')
  assert.ok(pathToFileURL(sample).href.includes('%20'), '空格必须被编码成 %20')
  // 两个脚本都必须用 pathToFileURL，且**实际代码**里不得手工拼接（注释里的
  // 反例说明不算）：只看非注释行。
  const fs2 = await import('node:fs')
  for (const file of ['scripts/check-sync-failure.mjs', 'scripts/report-sync-failure.mjs']) {
    const source = fs2.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.ok(source.includes('pathToFileURL('), `${file} 必须用 pathToFileURL 判定直接执行`)
    const codeLines = source.split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    assert.ok(!/`file:\/\/\$\{/.test(codeLines), `${file} 的实际代码不得手工拼接 file:// URL`)
  }
})

console.log(`cloud-sync: ${failures === 0 ? 'all ok' : `${failures} failure(s)`}`)
process.exitCode = failures > 0 ? 1 : 0
