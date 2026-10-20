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

// ── 分支自动创建（真实故障：404 Branch sync-failure not found） ───────────────

const apiBaseOf = (owner, repo) => `https://api.github.com/repos/${owner}/${repo}`

await checkAsync('目标分支不存在 ⇒ 自动从 base 分支的 HEAD 建出来', async () => {
  const calls = []
  const shaMain = 'f'.repeat(40)
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ url, method, body: init.body })
    if (url.includes('/git/ref/heads/sync-failure')) return new Response('{}', { status: 404 })
    if (url.includes('/git/ref/heads/main')) return Response.json({ object: { sha: shaMain } })
    if (url.endsWith('/git/refs') && method === 'POST') return Response.json({ ref: 'refs/heads/sync-failure' }, { status: 201 })
    throw new Error(`unexpected ${method} ${url}`)
  }
  const result = await report.ensureBranch({
    fetchImpl, headers: {}, branch: 'sync-failure', baseBranch: 'main', apiBase: apiBaseOf('o', 'r'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.created, true, '应真的创建了分支')
  const create = calls.find(call => call.method === 'POST')
  assert.deepEqual(JSON.parse(create.body), { ref: 'refs/heads/sync-failure', sha: shaMain })
})

await checkAsync('分支已存在 ⇒ 不重复创建', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET' })
    if (url.includes('/git/ref/heads/sync-failure')) return Response.json({ object: { sha: 'a'.repeat(40) } })
    throw new Error(`unexpected ${url}`)
  }
  const result = await report.ensureBranch({
    fetchImpl, headers: {}, branch: 'sync-failure', baseBranch: 'main', apiBase: apiBaseOf('o', 'r'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.created, false)
  assert.equal(calls.filter(call => call.method === 'POST').length, 0, '不该发创建请求')
})

await checkAsync('创建时撞 422（并发已建）⇒ 视为可用', async () => {
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/git/ref/heads/sync-failure')) return new Response('{}', { status: 404 })
    if (url.includes('/git/ref/heads/main')) return Response.json({ object: { sha: 'b'.repeat(40) } })
    return new Response('{"message":"Reference already exists"}', { status: 422 })
  }
  const result = await report.ensureBranch({
    fetchImpl, headers: {}, branch: 'sync-failure', baseBranch: 'main', apiBase: apiBaseOf('o', 'r'),
  })
  assert.equal(result.ok, true, '422 = 已存在，不是失败')
})

await checkAsync('reportSyncFailure：分支不存在时先建分支再 PUT（端到端契约）', async () => {
  const calls = []
  let branchExists = false
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ url, method })
    // 探测目标分支
    if (url.includes('/git/ref/heads/sync-failure')) {
      return branchExists ? Response.json({ object: { sha: 'c'.repeat(40) } }) : new Response('{}', { status: 404 })
    }
    if (url.includes('/git/ref/heads/main')) return Response.json({ object: { sha: 'd'.repeat(40) } })
    if (url.endsWith('/git/refs') && method === 'POST') { branchExists = true; return Response.json({}, { status: 201 }) }
    // 内容读写
    if (url.includes('/contents/')) {
      if (method === 'GET') return branchExists ? new Response('{}', { status: 404 }) : new Response('{}', { status: 404 })
      // 关键：分支不存在时 GitHub 返回 404（这正是原始故障）
      if (!branchExists) return new Response('{"message":"Branch sync-failure not found"}', { status: 404 })
      return Response.json({ content: { sha: 'e' } }, { status: 201 })
    }
    throw new Error(`unexpected ${method} ${url}`)
  }
  const result = await report.reportSyncFailure({
    payload: report.normalizeFailure({ failedStep: 'test-failed' }),
    token: 't', owner: 'o', repo: 'r', fetchImpl,
  })
  assert.equal(result.ok, true, `首次写入应成功（此前这里是 404）：${result.message}`)
  assert.ok(calls.some(call => call.method === 'POST' && call.url.endsWith('/git/refs')), '必须先建分支')
})

// ── revision 必须重算，不能用推送后的 HEAD（真实故障：云端正式跑红） ──────

await checkAsync('--ci 刷新 revision 必须用「最后触碰发布内容的提交」，不是 HEAD', async () => {
  // 2026-10-20 云端正式跑：
  //   c85e27e  build(channel-pack): 重建上游合并后的产物   ← 碰了发布内容
  //   b005cb2  catalog: sign the release over c85e27e      ← 只碰 catalog
  //   HEAD = b005cb2 ⇒ 旧实现把它写成 revision ⇒ 立刻就是错值
  //   effce98  catalog: refresh revision over b005cb2      ← 把对的改成错的
  // release-sign 报 `got "b005cb2", want "c85e27e"`。
  const fs2 = await import('node:fs')
  const source = fs2.readFileSync(new URL('./sync-upstream.mjs', import.meta.url), 'utf8')
  const startAt = source.indexOf('if (ciMode)')
  const ciBlock = source.slice(startAt, startAt + 14000)

  // ⚠️ 2026-10-20 收尾：算法收进 scripts/lib/catalog-revision.mjs（唯一实现）。
  //    这里断言的是「调用共用 helper，且在**远端**分支上算」，而不是某行 regex
  //    —— 后者只能证明写了什么，证明不了算得对（算法正确性由
  //    scripts/catalog-revision-test.mjs 用真实 git 仓库验证）。
  //
  // ⚠️ 切片必须卡在「写 catalog 之前」：自证段后面也会调 remoteContentRevision，
  //    否则把第一段改回 contentRevisionAt('HEAD') 仍然能匹配上（变异测试实测漏过）。
  const writeAt = ciBlock.indexOf('set-catalog-revision.mjs')
  const beforeWrite = ciBlock.slice(0, writeAt === -1 ? undefined : writeAt)
  assert.match(beforeWrite, /remoteContentRevision\(\s*workBranch/,
    '写入 catalog 之前必须在远端工作分支上重算 revision（本地 HEAD 不算）')
  assert.ok(!/contentRevisionAt\(\s*'HEAD'\s*,[^)]*\)\s*$/m.test(beforeWrite)
    || /const contentRevision = remoteContentRevision/.test(beforeWrite),
    '写 catalog 用的 contentRevision 不能取自本地 HEAD')
  // 且不能把 workHead / 推送前 sha 直接喂给 set-catalog-revision。
  assert.ok(!/set-catalog-revision\.mjs', workHead/.test(ciBlock),
    '不能用推送后的 HEAD 充当 revision（那会把正确的值改错）')
  assert.ok(!/set-catalog-revision\.mjs', preMergeHead/.test(ciBlock),
    '不能用推送前的 sha 充当 revision（远端根本不存在这个提交）')
  // 写完必须自证：catalog 记录值 == 远端重算值。
  assert.match(ciBlock, /catalogRevision\(\s*\{\s*root\s*\}\s*\)/, '必须读取 catalog 现值做自证')
  assert.match(ciBlock, /自证通过/, '自证失败要红，不能静默通过')
  // 提交信息也应引用重算值。
  assert.match(ciBlock, /refresh revision over \$\{contentRevision\.slice/, '提交信息应使用重算值')
})

await checkAsync('投影发布分支后也要在远端分支上自证 revision', async () => {
  const fs2 = await import('node:fs')
  const source = fs2.readFileSync(new URL('./sync-upstream.mjs', import.meta.url), 'utf8')
  const ciBlock = source.slice(source.indexOf('if (ciMode)'), source.indexOf('if (ciMode)') + 14000)
  // history 模式：main 与工作分支同提交 ⇒ 两边的远端重算值必须相等。
  assert.match(ciBlock, /remoteContentRevision\(\s*releaseBranch/,
    `投影后必须在 ${'${releaseBranch}'} 上重算并比对`)
  assert.match(ciBlock, /投影后 .* 的 revision 与工作分支不一致|revision 与工作分支不一致/,
    '不一致必须报错')
})

// ── 成功后清除失败记录（真实缺陷：同步成功却还在弹旧失败） ────────────────

await checkAsync('clearSyncFailure：有记录时删除（带 sha）', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ url, method, body: init.body })
    if (method === 'GET') return Response.json({ sha: 'deadbeef' })
    return new Response(null, { status: 200 })
  }
  const result = await report.clearSyncFailure({ token: 't', owner: 'o', repo: 'r', fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.deleted, true, '应真的删掉')
  const del = calls.find(call => call.method === 'DELETE')
  assert.equal(JSON.parse(del.body).sha, 'deadbeef', '删除必须带当前 sha')
})

await checkAsync('clearSyncFailure：404 视为「本来就没有」', async () => {
  const fetchImpl = async () => new Response('{"message":"Not Found"}', { status: 404 })
  const result = await report.clearSyncFailure({ token: 't', owner: 'o', repo: 'r', fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.deleted, false)
})

await checkAsync('clearSyncFailure：401/403 必须报错（不能当成「没有记录」）', async () => {
  // 真实风险：把「清除失败」静默当成「本来就没有」⇒ 旧失败记录永远留着，
  // 通知桥继续弹过期消息 —— 正是本次要修的缺陷的翻版。
  for (const status of [401, 403, 500]) {
    const fetchImpl = async () => new Response('{}', { status })
    const result = await report.clearSyncFailure({ token: 't', owner: 'o', repo: 'r', fetchImpl })
    assert.equal(result.ok, false, `HTTP ${status} 必须报错`)
    assert.match(result.reason, new RegExp(String(status)))
  }
})

await checkAsync('workflow：成功路径必须清除失败记录', async () => {
  const fs2 = await import('node:fs')
  const yamlText = fs2.readFileSync(new URL('../.github/workflows/sync-upstream.yml', import.meta.url), 'utf8')
  assert.match(yamlText, /report-sync-failure\.mjs --clear/, '成功时必须清除状态文件')
  // 条件必须是「sync_exit == 0」，否则会在失败时把刚写的记录删掉。
  const clearStep = yamlText.slice(yamlText.indexOf('报告') >= 0 ? yamlText.indexOf('报告') : yamlText.indexOf('清除失败记录'))
  assert.match(yamlText, /sync_exit == '0'/, '清除步骤的条件应为成功')
})

// ── 通知多通道（真实缺陷：launchd 的 osascript 被系统丢弃） ────────────────

await checkAsync('deliverNotification：osascript 被丢弃时，文件兜底仍算送达', async () => {
  const fs2 = await import('node:fs')
  const os2 = await import('node:os')
  const run = () => ({ status: 1, stderr: 'not authorized' })   // osascript 失败
  const calls = []
  const result = check.deliverNotification(
    { title: 'T', message: 'm', url: '' },
    {
      platform: 'darwin',
      run,
      // 模拟 macOS 但没装 terminal-notifier
      exists: path2 => path2.includes('terminal-notifier') ? false : fs2.existsSync(path2),
    },
  )
  assert.equal(result.ok, true, '至少 file 通道应当成功')
  const channels = result.attempted.map(entry => entry.channel)
  assert.ok(channels.includes('file'), '必须有文件兜底（必然成功的通道）')
  assert.ok(channels.includes('osascript'), '仍应尝试 osascript')
  // 文件通道必须真的写了东西（用户能 cat 到）。
  const alertLog = new URL('../.private/sync-alert.log', import.meta.url)
  assert.ok(fs2.existsSync(alertLog), '应生成 .private/sync-alert.log')
  assert.match(fs2.readFileSync(alertLog, 'utf8'), /T: m/)
})

await checkAsync('deliverNotification：非 macOS 退化为 stdout，不调系统通知', async () => {
  let called = false
  const result = check.deliverNotification(
    { title: 'T', message: 'm', url: '' },
    { platform: 'linux', run: () => { called = true; return { status: 0 } } },
  )
  assert.equal(called, false)
  assert.equal(result.attempted[0].channel, 'stdout')
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

await checkAsync('有 token 时走 API（无 CDN 缓存）并解包 base64 信封', async () => {
  // 真实缺陷（2026-10-20）：raw.githubusercontent 有 CDN 缓存，云端清除状态
  // 文件后本机仍读到旧失败 ⇒ 通知继续误报。
  const payload = { failedAt: '2026-10-20T00:00:00Z', failedStep: 'test-failed', conflictedFiles: [] }
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} })
    return Response.json({ content: Buffer.from(JSON.stringify(payload)).toString('base64'), encoding: 'base64' })
  }
  const result = await check.fetchFailureState({ token: 't', fetchImpl })
  assert.equal(result.exists, true)
  assert.equal(result.payload.failedStep, 'test-failed')
  const call = calls[0]
  assert.match(call.url, /api\.github\.com/, '有 token 时必须走 API 而不是 raw')
  assert.ok(!call.url.includes('raw.githubusercontent.com'))
  assert.equal(call.headers['cache-control'], 'no-cache', '必须请求不缓存')
})

await checkAsync('无 token 时退回 raw（公开仓库）', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(url)
    return new Response(JSON.stringify({ failedStep: 'merge-conflict' }), { status: 200 })
  }
  const result = await check.fetchFailureState({ token: '', fetchImpl })
  assert.equal(result.exists, true)
  assert.match(calls[0], /raw\.githubusercontent\.com/)
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

// ── 端到端：--fail-file 真的写得出来（Tester 复核抓到的阻断缺陷） ────────────
// 真实缺陷（2026-10-19）：`sync-upstream.mjs` 调了 `flag('fail-file')` 却
// **从没定义 `flag`**，而那行在 catch 块里、回滚之后 ⇒ 抛 `TypeError`，
// 状态文件永远写不出来 ⇒「云端失败 ⇒ 通知」整条链路在第一步就断，用户只看到
// 「失败了，原因未知」。当时本文件 17/17 全绿，因为它只测了 report/check
// 两个脚本，**没测本脚本的 --fail-file**。
//
// 这条用**临时 git clone** 隔离跑：`OFM_SYNC_TESTS` 注入一个必失败的脚本，
// 断言文件存在且字段齐全。不动当前工作区（脏树会被脚本自己拒绝）。
// ── 工作分支 / 发布分支语义（2026-10-19 结构性修正） ──────────────────────

await checkAsync('isGeneratedPath 覆盖独立端构建产物（否则合并必冲突）', async () => {
  const fs2 = await import('node:fs')
  const source = fs2.readFileSync(new URL('./sync-upstream.mjs', import.meta.url), 'utf8')
  // 真实故障（2026-10-19 云端 dry-run）：基于 squash 的 main 合并时，
  // packages/standalone/web/** 是构建产物（含带 hash 的分包），
  // 出现 rename/delete、modify/delete 轮番冲突。正确做法永远是「取 ours + 重建」。
  assert.match(source, /GENERATED_PREFIXES/, '必须有按目录前缀判定的生成产物集合')
  assert.match(source, /'packages\/standalone\/web\/'/, '独立端产物目录必须在里面')
  assert.match(source, /export function isGeneratedPath/, '判定要可导出以便测试')
})

await checkAsync('sync-upstream 支持 --work-branch 语义（不写死 main）', async () => {
  const fs2 = await import('node:fs')
  const source = fs2.readFileSync(new URL('./sync-upstream.mjs', import.meta.url), 'utf8')
  assert.match(source, /OFM_WORK_BRANCH/, '工作分支必须可配置')
  assert.match(source, /OFM_MAIN_SYNC_MODE/, '发布分支同步策略必须可配置')
  // 合并后必须重建独立端产物（否则云端 build-standalone-ui --check 会红）
  assert.match(source, /build-standalone-ui\.mjs/, '合并后必须重建独立端产物')
})

await checkAsync('esbuild 解析必须覆盖 packages/standalone（云端构建前提）', async () => {
  // 真实故障（2026-10-19 dry-run）：干净 checkout 里装完依赖仍报
  //   `build-channel-pack: esbuild is required to rebuild the pack`
  // 因为 esbuild 是 packages/standalone 的 devDependency，不在根 package.json，
  // 而原解析路径只有 [OFM_ESBUILD_DIR, cwd, root] —— 永远进不到子包。
  const fs2 = await import('node:fs')
  const source = fs2.readFileSync(new URL('./build-channel-pack.mjs', import.meta.url), 'utf8')
  assert.match(source, /'packages', 'standalone'/, '解析候选必须包含 packages/standalone')
  // 版本不能在两个地方各写一份（本文件的候选即可跟随子包钉定值）。
  assert.ok(!/from 'esbuild'|"esbuild":\s*"\d/.test(source), '不得在本脚本里另写 esbuild 版本号')
})

await checkAsync('workflow 必须安装独立端依赖（esbuild / vite 都在那里）', async () => {
  const fs2 = await import('node:fs')
  const yamlText = fs2.readFileSync(new URL('../.github/workflows/sync-upstream.yml', import.meta.url), 'utf8')
  assert.match(yamlText, /packages\/standalone && npm ci/, '必须装独立端依赖')
  // 两个 lockfile 都要还原（否则脏树检查拒绝，且 manifest digest 会漂移）。
  assert.match(yamlText, /packages\/standalone\/package-lock\.json/, '独立端 lockfile 也要还原')
})

await checkAsync('workflow 检出 custom-main（事实源），不是 main', async () => {
  const fs2 = await import('node:fs')
  const yamlText = fs2.readFileSync(new URL('../.github/workflows/sync-upstream.yml', import.meta.url), 'utf8')
  // 结构化断言：checkout 的 ref 必须是 custom-main。
  const checkoutBlock = yamlText.slice(yamlText.indexOf('actions/checkout'))
  const refMatch = /ref:\s*(\S+)/.exec(checkoutBlock)
  assert.ok(refMatch !== null, 'checkout 必须有 ref')
  assert.equal(refMatch[1], 'custom-main', '必须检出带完整上游祖先的事实源分支')
  assert.match(yamlText, /OFM_MAIN_SYNC_MODE:\s*history/, 'main 应与工作分支同历史（常规历史）')
})

await checkAsync('--fail-file 在失败时真的写出状态文件（端到端，隔离 clone）', async () => {
  const { execFileSync } = await import('node:child_process')
  const fs2 = await import('node:fs')
  const os2 = await import('node:os')

  // ⚠️ 必须用 fileURLToPath：`new URL(...).pathname` 里是百分号编码的
  //（本仓库路径含空格 ⇒ `%20`），git 会当成真实目录名去找而失败。
  const { fileURLToPath } = await import('node:url')
  const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  const work = fs2.mkdtempSync(path.join(os2.tmpdir(), 'ofm-failfile-'))
  const clone = path.join(work, 'repo')
  execFileSync('git', ['clone', '--no-hardlinks', '--quiet', repo, clone], { stdio: 'ignore' })

  // ⚠️ clone 拿到的是 **HEAD 里的脚本**，而本用例要测的是**当前工作区**的版本
  //（改动可能还没提交）。把工作区文件覆盖进去，否则测的是旧代码 —— 这正是
  // 第一次跑这条用例时它「通过不了」的原因：clone 里还是没定义 `flag` 的旧版。
  //
  // ⚠️ 新增的模块文件（如 `scripts/lib/catalog-revision.mjs`）也必须一起复制：
  // 同步脚本现在 import 它，缺了就在 clone 里报 ERR_MODULE_NOT_FOUND，而症状是
  // 「状态文件没写出来」—— 看起来像 failOut 的 bug，实际是夹具缺文件。
  for (const rel of ['scripts/sync-upstream.mjs', 'scripts/lib/catalog-revision.mjs']) {
    fs2.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true })
    fs2.copyFileSync(path.join(repo, rel), path.join(clone, rel))
  }
  // 一个必定失败的测试脚本。
  fs2.writeFileSync(path.join(clone, 'scripts', 'always-fail-test.mjs'), 'process.exit(1)\n')
  execFileSync('git', ['add', '-A'], { cwd: clone })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'fixture'], { cwd: clone })

  /**
   * 让 clone 的 upstream 指向**自己**的一个更旧提交：这样 merge 一定有内容可合，
   * 从而真正走到「跑测试」那一步（而不是「上游无新提交」直接退出）。
   *
   * ⚠️ 两个坑（都踩过）：
   * 1. 必须先 `git remote add upstream`，否则脚本第一步 `git fetch upstream`
   *    就失败，走的是 fetch-failed 路径（要测，但不是本用例的目标）；
   * 2. 脚本 fetch 的是 `main`，而 clone 的检出分支取决于**源仓库当前分支**
   *    ⇒ 报 `couldn't find remote ref main`。故要在 clone 里造一个 `main`。
   *
   * ⚠️ **绝不能写死分支名**：本用例原先 `git checkout -q custom-main`，
   * 而云端 CI 检出的仓库只有 `main`（`custom-main` 只在作者的本地）⇒
   * 在 GitHub Actions 里报 `pathspec 'custom-main' did not match`（真实故障，
   * 2026-10-19 offline job）。改为记下**检出时的 HEAD**，最后回到那里。
   */
  const startRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8' }).trim()
  // ⚠️ 关键：`main` 必须是**当前 HEAD 的祖先所不含**的提交，否则脚本判定
  // 「上游已在本地历史中」直接成功退出（那样根本走不到测试环节）。
  // 做法：从 clone 里 checkout 出一个**平行分支**并加一个提交，让它与 HEAD 分叉。
  execFileSync('git', ['checkout', '-q', '-b', 'upstream-fixture', 'HEAD'], { cwd: clone })
  fs2.writeFileSync(path.join(clone, 'upstream-marker.txt'), 'upstream side\n')
  execFileSync('git', ['add', 'upstream-marker.txt'], { cwd: clone })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'upstream side'], { cwd: clone })
  execFileSync('git', ['branch', '-f', 'main', 'upstream-fixture'], { cwd: clone })
  // 回到检出时的提交（detached 亦可 —— 脚本只关心 HEAD 的内容与历史）。
  execFileSync('git', ['checkout', '-q', startRef], { cwd: clone })
  execFileSync('git', ['remote', 'add', 'upstream', clone], { cwd: clone })
  execFileSync('git', ['fetch', '--quiet', 'upstream', 'main:refs/remotes/upstream/main'], { cwd: clone })

  const failFile = path.join(work, 'fail.json')
  let exitCode = 0
  try {
    execFileSync(process.execPath, ['scripts/sync-upstream.mjs', '--ci', '--fail-file', failFile], {
      cwd: clone,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, OFM_SYNC_TESTS: 'scripts/always-fail-test.mjs' },
    })
  } catch (error) {
    exitCode = typeof error.status === 'number' ? error.status : 1
  }

  assert.equal(exitCode, 1, '同步失败时脚本必须以 exit 1 退出')
  assert.ok(fs2.existsSync(failFile), `状态文件必须存在：${failFile}`)
  const payload = JSON.parse(fs2.readFileSync(failFile, 'utf8'))
  for (const key of ['failedAt', 'failedStep', 'message', 'conflictedFiles', 'runUrl']) {
    assert.ok(key in payload, `状态文件缺少字段 ${key}`)
  }
  /**
   * 失败步骤：`test-failed` 或 `build-failed` 都算通过。
   *
   * 为什么放宽：隔离 clone 里没有 `node_modules`，`build-channel-pack.mjs`
   * 会因为找不到 esbuild 先失败 —— 那样根本走不到测试环节。本用例的**目标**
   * 是证明「失败时状态文件写得出来且字段齐全」，不是证明「测试失败被正确分类」
   *（后者由 `classifyFailure` 的单元语义保证）。两个分支都说明「失败被如实记录」。
   */
  assert.ok(['test-failed', 'build-failed'].includes(payload.failedStep),
    `失败步骤应归类为 test-failed 或 build-failed，实际 ${payload.failedStep}`)
  assert.ok(Array.isArray(payload.conflictedFiles))
  // 收尾：删掉临时克隆。
  fs2.rmSync(work, { recursive: true, force: true })
})

// ── set-catalog-revision：云端二次刷新用 ─────────────────────────────────────

await checkAsync('setCatalogRevision 写入两处 revision（且校验 sha 格式）', async () => {
  const fs2 = await import('node:fs')
  const os2 = await import('node:os')
  const { setCatalogRevision, REVISION_TARGETS } = await import('./set-catalog-revision.mjs')

  const dir = fs2.mkdtempSync(path.join(os2.tmpdir(), 'ofm-setrev-'))
  fs2.mkdirSync(path.join(dir, 'catalog'), { recursive: true })
  fs2.writeFileSync(path.join(dir, 'catalog/dsh-plugin.json'),
    JSON.stringify({ version: '2.5.4', source: { revision: 'old', version: '2.5.4' } }, null, 2))
  fs2.writeFileSync(path.join(dir, 'catalog/provenance.json'),
    JSON.stringify({ subject: { sourceRevision: 'old' } }, null, 2))

  const sha = 'a'.repeat(40)
  const result = setCatalogRevision(sha, { root: dir })
  assert.equal(result.changed.length, 2, '两处都要写')
  assert.deepEqual(REVISION_TARGETS.map(t => t.file).sort(), ['catalog/dsh-plugin.json', 'catalog/provenance.json'])

  const catalog = JSON.parse(fs2.readFileSync(path.join(dir, 'catalog/dsh-plugin.json'), 'utf8'))
  assert.equal(catalog.source.revision, sha)
  assert.equal(catalog.source.version, '2.5.4', '不能顺手改动 version')
  const provenance = JSON.parse(fs2.readFileSync(path.join(dir, 'catalog/provenance.json'), 'utf8'))
  assert.equal(provenance.subject.sourceRevision, sha)

  // 幂等：同一 sha 再写一次不该产生变更。
  const again = setCatalogRevision(sha, { root: dir })
  assert.deepEqual(again.changed, [], '同值重复写应无变更')
  assert.equal(again.skipped.length, 2)

  // 非法 sha：必须报错（不能把短 sha / 大写写进 catalog）。
  assert.throws(() => setCatalogRevision('abc123', { root: dir }), /40 位/)
  assert.throws(() => setCatalogRevision('A'.repeat(40), { root: dir }), /40 位/)
})

await checkAsync('--ci 推送：先推工作分支（完整历史），再投影发布分支', async () => {
  // 2026-10-19 结构性修正：云端必须基于**带完整上游祖先**的 custom-main 工作。
  // 基于 squash 的 main 合并会让三方合并基准退化为旧祖先 ⇒ 必然大量冲突
  //（云端 dry-run 实测 10 个文件：README / client.js / package.json / standalone/*）。
  const fs2 = await import('node:fs')
  const source = fs2.readFileSync(new URL('./sync-upstream.mjs', import.meta.url), 'utf8')
  // ⚠️ 切片边界：`if (ciMode)` 之后**第一个** `} else {` 可能落在别的分支上。
  // 用行号定位到「下一个顶层 else」为止，取足够长的窗口（到推送段结束）。
  const startAt = source.indexOf('if (ciMode)')
  const ciBlock = source.slice(startAt, startAt + 9000)

  // 工作分支至少推两次：①首次推 merge 结果 ②刷新 revision 后再推
  const workPushes = (ciBlock.match(/push', 'origin', `HEAD:\$\{workBranch\}`/g) ?? []).length
  assert.ok(workPushes >= 2, `工作分支应至少推两次（实测 ${workPushes}）`)
  assert.match(ciBlock, /set-catalog-revision\.mjs/, '刷新 revision 必须复用该脚本')

  // 发布分支投影：默认 history（force-with-lease 对齐），保留 squash 兼容分支。
  assert.match(ciBlock, /force-with-lease/, 'history 模式用 force-with-lease 对齐 main')
  assert.match(ciBlock, /OFM_MAIN_SYNC_MODE/, '投影策略必须可配置')

  // 推送前必须有「祖先检查」，否则本机用 --ci 试跑只会得到一句
  // "failed to push some refs"，看不出是模式与本机分支布局不匹配。
  assert.match(ciBlock, /merge-base.*--is-ancestor/, '推送前必须检查 HEAD 是否为远端后代')

  // ⚠️ 不得 reset --hard 到远端（会丢本地 merge 历史）。只看非注释行。
  const ciCode = ciBlock.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*|\*\/)/.test(line)).join('\n')
  assert.ok(!/reset.*--hard.*origin\//.test(ciCode), '不得 reset --hard 到远端分支')
})

console.log(`cloud-sync: ${failures === 0 ? 'all ok' : `${failures} failure(s)`}`)
process.exitCode = failures > 0 ? 1 : 0
