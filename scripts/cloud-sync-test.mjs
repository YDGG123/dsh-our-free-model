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

// ── 端到端：--fail-file 真的写得出来（Tester 复核抓到的阻断缺陷） ────────────
// 真实缺陷（2026-10-19）：`sync-upstream.mjs` 调了 `flag('fail-file')` 却
// **从没定义 `flag`**，而那行在 catch 块里、回滚之后 ⇒ 抛 `TypeError`，
// 状态文件永远写不出来 ⇒「云端失败 ⇒ 通知」整条链路在第一步就断，用户只看到
// 「失败了，原因未知」。当时本文件 17/17 全绿，因为它只测了 report/check
// 两个脚本，**没测本脚本的 --fail-file**。
//
// 这条用**临时 git clone** 隔离跑：`OFM_SYNC_TESTS` 注入一个必失败的脚本，
// 断言文件存在且字段齐全。不动当前工作区（脏树会被脚本自己拒绝）。
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
  for (const rel of ['scripts/sync-upstream.mjs']) {
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
   * 2. 脚本 fetch 的是 `main`，而 clone 只有 `custom-main` ⇒ 报
   *    `couldn't find remote ref main`。故要在 clone 里造一个 `main`。
   */
  // ⚠️ 关键：`main` 必须是**当前 HEAD 的祖先所不含**的提交，否则脚本判定
  // 「上游已在本地历史中」直接成功退出（那样根本走不到测试环节）。
  // 做法：从 clone 里 checkout 出一个**平行分支**并加一个提交，让它与 HEAD 分叉。
  execFileSync('git', ['checkout', '-q', '-b', 'upstream-fixture', 'HEAD'], { cwd: clone })
  fs2.writeFileSync(path.join(clone, 'upstream-marker.txt'), 'upstream side\n')
  execFileSync('git', ['add', 'upstream-marker.txt'], { cwd: clone })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'upstream side'], { cwd: clone })
  execFileSync('git', ['branch', '-f', 'main', 'upstream-fixture'], { cwd: clone })
  execFileSync('git', ['checkout', '-q', 'custom-main'], { cwd: clone })
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

await checkAsync('sync-upstream 的 --ci 推送是**两段式**（推完再刷新 revision 再推）', async () => {
  // 真实故障（2026-10-19 run 39244615254）：只推一次时，catalog 里的 revision
  // 指向**本地** sha，而远端是新的 squash commit ⇒ 远端 main 上
  // `catalog-test` 报 got/want 不一致，release-sign 红。
  const fs2 = await import('node:fs')
  const source = fs2.readFileSync(new URL('./sync-upstream.mjs', import.meta.url), 'utf8')
  assert.match(source, /scripts\/set-catalog-revision\.mjs/, '推完必须刷新 revision')
  // 刷新后必须再推一次（否则远端仍是旧 revision）。
  const ciBlock = source.slice(source.indexOf('if (ciMode)'), source.indexOf('} else {', source.indexOf('if (ciMode)')))
  const pushes = ciBlock.match(/\['push', 'origin'/g) ?? []
  assert.ok(pushes.length >= 2, `--ci 分支应有两次 push（实际 ${pushes.length}）`)
  // 刷新后要自证，不靠推断。
  assert.match(ciBlock, /catalog-test\.mjs/, '刷新后必须跑 catalog-test 自证')
  // 推送前必须有「祖先检查」，否则本机用 --ci 试跑只会得到一句
  // "failed to push some refs"，看不出是模式与本机分支布局不匹配。
  assert.match(ciBlock, /merge-base.*--is-ancestor/, '推送前必须检查 HEAD 是否为远端后代')
  assert.match(ciBlock, /只能用于云端全新 checkout/, '拒绝时必须说明原因与替代做法')
  // ⚠️ 不能用 reset --hard 到远端：会丢掉本地 merge 历史。
  // 只看**非注释行**（注释里会引用这句话作为反例说明）。
  const ciCode = ciBlock.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*|\*\/)/.test(line)).join('\n')
  assert.ok(!/reset.*--hard.*origin\//.test(ciCode), '不得 reset --hard 到远端分支')
})

console.log(`cloud-sync: ${failures === 0 ? 'all ok' : `${failures} failure(s)`}`)
process.exitCode = failures > 0 ? 1 : 0
