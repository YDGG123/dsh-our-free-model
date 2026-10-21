/**
 * `api-push-squash.mjs` 的易错点回归：**删除条目的 tree mode**、
 * **API 错误提示**、**发布内容判定**、**两段式第二段真的推得出去**、
 * **远端 revision 的真查询**。
 *
 * ## 为什么需要它（2026-10-19 / 10-21 两次线上实锤）
 *
 * 1. 推送差异里含删除文件时 `POST /git/trees` 返回 422 `Must supply a valid
 *    tree.mode`：`git diff-tree` 的删除记录 newMode 是 `"000000"`，原实现原样
 *    发给 GitHub。故把解析抽成纯函数 `parseDiffTree` 并在这里直接喂字符串。
 * 2. 第二段用 `HEAD^{tree}` 推**工作区**改动 ⇒ 树与远端相同 ⇒ 静默 `return null`，
 *    两段式从未生效（见 `workingTreeWith` 用例）。
 *
 * Run: node scripts/api-push-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const {
  parseDiffTree, describeApiError, DELETED_ENTRY_MODE, pushTouchesReleaseContent, workingTreeWith,
} = await import('./api-push-squash.mjs')
const { fetchRemoteReleaseRevision } = await import('./lib/catalog-revision.mjs')

let failures = 0
const check = (name, run) => {
  try { run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}

/** 构造一条 diff-tree 记录（`-z` 格式）。 */
const record = (oldMode, newMode, oldSha, newSha, status, path) =>
  `:${oldMode} ${newMode} ${oldSha} ${newSha} ${status}\0${path}\0`

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

// ── 删除条目 ─────────────────────────────────────────────────────────────────

check('删除条目：mode 必须归一成 100644（不能原样用 000000）', () => {
  const raw = record('100644', '000000', SHA_A, '0000000000000000000000000000000000000000', 'D', 'old-file.txt')
  const [entry] = parseDiffTree(raw)
  assert.equal(entry.status, 'D')
  assert.equal(entry.mode, DELETED_ENTRY_MODE, '删除条目的 mode 必须是合法值')
  assert.equal(entry.mode, '100644')
  assert.notEqual(entry.mode, '000000', '这就是 422 Must supply a valid tree.mode 的成因')
})

check('删除条目在 tree 请求里是 {mode, sha:null}（不是全零 mode）', () => {
  const raw = record('100644', '000000', SHA_A, '0000000000000000000000000000000000000000', 'D', 'gone.md')
  const [entry] = parseDiffTree(raw)
  // 模拟 main() 里构造 items 的那两行。
  const item = { path: entry.path, mode: entry.mode, type: 'blob', sha: null }
  assert.deepEqual(item, { path: 'gone.md', mode: '100644', type: 'blob', sha: null })
})

// ── 非删除条目：mode 必须保留 ────────────────────────────────────────────────

check('新增/修改条目：保留 newMode（100644）', () => {
  const [entry] = parseDiffTree(record('000000', '100644', '0'.repeat(40), SHA_B, 'A', 'new.txt'))
  assert.equal(entry.mode, '100644')
  assert.equal(entry.newSha, SHA_B)
})

check('可执行位必须保留：100755 不能被改写成 100644', () => {
  // 真实风险：为了修删除条目而「统一写成 100644」，会把脚本的可执行位抹掉
  //（脚本能跑但 `./x.sh` 会 Permission denied）。
  const [entry] = parseDiffTree(record('100644', '100755', SHA_A, SHA_B, 'M', 'run.sh'))
  assert.equal(entry.mode, '100755', '可执行位不能丢')
})

check('重命名（R）与复制（C）按非删除处理，沿用 newMode', () => {
  const [renamed] = parseDiffTree(record('100644', '100644', SHA_A, SHA_B, 'R', 'new-name.txt'))
  assert.equal(renamed.mode, '100644')
  const [copied] = parseDiffTree(record('100644', '100755', SHA_A, SHA_B, 'C', 'copy.sh'))
  assert.equal(copied.mode, '100755')
})

// ── 多条记录与边界 ───────────────────────────────────────────────────────────

check('多条记录：每条各自解析，删除条目单独归一', () => {
  const raw = record('000000', '100644', '0'.repeat(40), SHA_A, 'A', 'a.txt')
    + record('100644', '100755', SHA_A, SHA_B, 'M', 'b.sh')
    + record('100644', '000000', SHA_B, '0'.repeat(40), 'D', 'c.txt')
  const entries = parseDiffTree(raw)
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map(e => e.path), ['a.txt', 'b.sh', 'c.txt'])
  assert.deepEqual(entries.map(e => e.mode), ['100644', '100755', '100644'])
  assert.deepEqual(entries.map(e => e.status), ['A', 'M', 'D'])
})

check('空输入 ⇒ 空列表（不抛错）', () => {
  assert.deepEqual(parseDiffTree(''), [])
})

check('格式非法 ⇒ 抛出带原文的错误（不静默跳过）', () => {
  assert.throws(() => parseDiffTree('not-a-diff-record\0x.txt\0'), /无法解析 diff 记录/)
})

// ── API 错误提示 ─────────────────────────────────────────────────────────────

check('404 必须提示 workflow scope（今天踩过的误导性错误）', () => {
  const text = describeApiError({ method: 'POST', endpoint: '/git/trees', status: 404, message: 'Not Found' })
  assert.match(text, /404/)
  assert.match(text, /workflow/, '必须点名 workflow scope —— 这是 404 最可能的原因')
  assert.match(text, /403/, '要点明它不是 403，否则会误判成普通权限问题')
})

check('401 提示 token 无效/过期', () => {
  const text = describeApiError({ method: 'GET', endpoint: '/git/refs/heads/main', status: 401, message: 'Bad credentials' })
  assert.match(text, /token 无效或已过期/)
})

check('422 提示 mode 非法 / 并发写入', () => {
  const text = describeApiError({ method: 'POST', endpoint: '/git/trees', status: 422, message: 'Must supply a valid tree.mode' })
  assert.match(text, /mode/)
  assert.match(text, /sha:null|并发/)
})

check('403 提示权限不足或限流', () => {
  const text = describeApiError({ method: 'PUT', endpoint: '/git/refs/heads/main', status: 403, message: 'Forbidden' })
  assert.match(text, /限流|权限不足/)
})

check('其它状态码原样透出，不编造提示', () => {
  const text = describeApiError({ method: 'GET', endpoint: '/x', status: 500, message: 'Server Error' })
  assert.equal(text, 'GET /x -> HTTP 500: Server Error')
})

// ── 两段式推送（真实故障：release-sign 因 revision 失效变红） ──────────────

await (async () => {
  const fs2 = await import('node:fs')
  const source = fs2.readFileSync(new URL('./api-push-squash.mjs', import.meta.url), 'utf8')
  check('api-push-squash 推完必须刷新 revision 并二次推送（两段式）', () => {
    // 2026-10-19 release-sign run 39244615254：squash 推送后远端是新提交，
    // catalog 里记的本地 sha 在远端不存在（GET /git/commits/<local> → 404），
    // 于是 release 套件的 catalog-test 报 got/want 不一致。
    assert.match(source, /set-catalog-revision\.mjs/, '必须复用 set-catalog-revision')
    assert.match(source, /pushOneCommit/, '推送逻辑要可复用（两段各推一次）')
    const callSites = source.match(/await pushOneCommit\(/g) ?? []
    assert.ok(callSites.length >= 2, `必须有两段推送（实际 ${callSites.length} 处调用）`)
    /**
     * ⚠️ 2026-10-20 收尾：第二段的 revision **不能**就是刚推上去的 sha。
     * 若这次推送没碰发布内容（例如上游只改 README），「最后触碰发布内容的
     * 提交」是更早的某个提交 —— 拿 push 出来的新提交去写，等于让 catalog
     * 说了句假话。判据必须来自 `lib/catalog-revision.mjs`。
     *
     * ⚠️ 断言要卡在**调用点**：只匹配 `resolveRemoteRevision(` 会被函数定义
     * 本身命中，于是 `const revision = pushedSha` 的变异照样全绿（实测漏过）。
     */
    assert.match(source, /const resolved = await resolveRemoteRevision\(\{/,
      '第二段 revision 必须由远端重算决定（调用点，非定义）')
    assert.match(source, /resolveRemoteReleaseRevision\(/, '必须复用 lib/catalog-revision（唯一实现）')
    assert.ok(!/refreshCatalogRevision\(pushedSha\)/.test(source),
      '不能把刚推上去的 sha 直接当 revision（它可能没碰发布内容）')
    assert.ok(!/const revision = pushedSha/.test(source),
      '不能把刚推上去的 sha 直接当 revision（同上一行的等价写法）')
  })

  check('api-push-squash 写完必须自证：远端真相 == 写进去的值', () => {
    // 自证必须问**远端**（git fetch 或 API 真查询），不是读本地文件自说自话。
    assert.match(source, /verifyRemoteRevision\(/, '必须有推送后自证')
    assert.match(source, /resolveRemoteReleaseRevision\(/, '自证要能走 git fetch 重算')
    assert.match(source, /resolveRemoteReleaseRevision\([\s\S]{0,200}?gitAttempts/, '自证要能走 API 真查询（判定过 git 不通就不再等）')
    assert.ok(!/自证跳过/.test(source), '不允许存在「跳过自证」的静默路径')
    // 第二段只该动 catalog；真动了发布内容说明混入了别的差异。
    assert.match(source, /touchedReleaseContent/, '必须判断这次推送动没动发布内容')
  })

  check('推送后把本地 catalog 还原（否则每次都留下一棵脏树）', () => {
    assert.match(source, /catalogSnapshot/, '写之前要留一份原样')
    assert.match(source, /catalogSnapshot\)\)\s*\{[\s\S]{0,120}?fs\.writeFileSync/, '推送成功后要还原')
  })

  check('降级基线必须是**推送前**读到的（推送后读会读到我们自己的内容）', () => {
    // ⚠️ 真实缺陷（2026-10-20 收尾时自查发现）：第一版降级路径在写完 catalog
    // 之后才去读远端 catalog 现值。但那时远端已经是我们刚推上去的内容 ——
    // 于是「保持现值」变成「把过期值原样写回去」，等于什么都没修。
    const pushAt = source.indexOf('const pushed = await pushOneCommit(')
    const baselineAt = source.indexOf('const baselineRevision = await readRemoteCatalogRevision()')
    assert.ok(baselineAt !== -1, '必须在推送前读远端 catalog 基线')
    assert.ok(baselineAt < pushAt, '基线必须早于第一段推送（否则读到的是自己刚推的内容）')
    assert.match(source, /baselineRevision,/, '基线必须传给 revision 判定')
  })

  check('git 传输不可用只判定一次（不重复等 75 秒）', () => {
    // 本机 github:443 被阻断，单次失败要等 75 秒。判定过就记住，别再试。
    assert.match(source, /gitTransportUnavailable/, '必须有「传输不可用」的记忆标志')
    assert.match(source, /gitAttempts: gitTransportUnavailable \? 0 : 1/, '第一次之后不应再尝试 fetch（跳过 git 直接真查询）')
  })

  check('按同一套差异推送：删除条目 mode 仍走 DELETED_ENTRY_MODE', () => {
    // 两段式重构后，删除条目的归一必须在**共用的** pushOneCommit 里，
    // 否则第二段（只推 catalog/feed）虽不受影响，但第一段会退回 422。
    assert.match(source, /status === 'D'[\s\S]{0,80}entry\.mode/, '删除条目必须用 parseDiffTree 归一后的 mode')
  })

  /**
   * ── 「用了没导入」这一类：必须**执行**到那行代码 ─────────────────────────
   *
   * ⚠️ 真实缺陷（2026-10-21 真机推送）：`pushOneCommit` 里调用了
   * `isReleaseContentPath` 却没有 import，推送一跑到那行就 ReferenceError 中断。
   * 当时代码是**全绿**的 —— 这条判定藏在需要网络的函数深处，没有任何测试
   * 执行过它；用例只测了 helper 本身（那个文件里它是本地定义）。
   *
   * 所以判定逻辑抽成导出的 `pushTouchesReleaseContent`，用例直接调用它：
   * 少一个 import 就会在这里炸出来，而不是等真机推送。
   */
  check('发布内容判定：调用真实代码路径（缺 import 会在此炸出来）', () => {
    const paths = ['package.json', 'src', 'client.js']
    assert.equal(pushTouchesReleaseContent([{ path: 'catalog/dsh-plugin.json' }], paths), false,
      '只改 catalog 不算动了发布内容')
    assert.equal(pushTouchesReleaseContent([{ path: 'README.md' }], paths), false,
      'README 不在 files 里')
    assert.equal(pushTouchesReleaseContent([{ path: 'src/index.js' }], paths), true,
      '目录前缀要算发布内容')
    assert.equal(pushTouchesReleaseContent([{ path: 'client.js' }], paths), true)
    assert.equal(pushTouchesReleaseContent([], paths), false)
    // 混合条目：只要有一个碰了发布内容就算（降级路径据此选 revision）。
    assert.equal(pushTouchesReleaseContent(
      [{ path: 'catalog/dsh-plugin.json' }, { path: 'package.json' }], paths), true)
  })

  check('共用 helper 的名字：用了就必须导入（窄口径静态校验）', () => {
    const libSource = fs2.readFileSync(new URL('./lib/catalog-revision.mjs', import.meta.url), 'utf8')
    const exported = [...libSource.matchAll(/export (?:function|const|class) ([A-Za-z_$][\w$]*)/g)]
      .map(match => match[1])
    assert.ok(exported.length > 0, '应该能从 helper 里解析出导出名')
    for (const file of ['api-push-squash.mjs', 'sync-upstream.mjs']) {
      const text = fs2.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      const clause = /import\s*\{([^}]*)\}\s*from\s*'\.\/lib\/catalog-revision\.mjs'/.exec(text)
      const imported = new Set(clause === null
        ? []
        : clause[1].split(',').map(item => item.trim()).filter(Boolean))
      const body = clause === null ? text : text.replace(clause[0], '')
      const missing = exported.filter(name =>
        new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(body) && !imported.has(name))
      assert.deepEqual(missing, [], `${file} 用了但没从 helper 导入：${missing.join(', ')}`)
    }
  })

  /**
   * ── 两段式第二段**真的推得出去**（真实缺陷，2026-10-21：静默空过） ──────
   *
   * 第二段只改**工作区**的 catalog 文件（`set-catalog-revision.mjs` 写盘、不提交），
   * 而 `pushOneCommit` 原来一律用 `HEAD^{tree}` ⇒ 树与远端相同 ⇒ `return null`，
   * 什么都没推，还打印「✅ 第二段无差异」的假成功。
   *
   * 实测：远端 `main` 的 revision 因此永远停在本地记的值（`89f26ae`），
   * 而校验器要的是投影提交（`f04a6f4`）—— 两段式在本机通道从未生效。
   */
  check('workingTreeWith：工作区改动必须编进树（否则第二段静默空过）', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-workingtree-'))
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    }
    const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8', stdio: 'pipe' }).trim()
    try {
      git('init', '-q', '-b', 'main')
      fs.writeFileSync(path.join(work, 'package.json'), '{"name":"x","files":["src"]}\n')
      fs.mkdirSync(path.join(work, 'catalog'))
      fs.writeFileSync(path.join(work, 'catalog', 'dsh-plugin.json'), `{"source":{"revision":"${'a'.repeat(40)}"}}\n`)
      fs.writeFileSync(path.join(work, 'catalog', 'provenance.json'), `{"subject":{"sourceRevision":"${'a'.repeat(40)}"}}\n`)
      git('add', '-A')
      git('commit', '-q', '-m', 'base')
      const headTree = git('rev-parse', 'HEAD^{tree}')

      // 只改工作区（不提交）—— 这正是第二段的处境。
      fs.writeFileSync(path.join(work, 'catalog', 'dsh-plugin.json'), `{"source":{"revision":"${'b'.repeat(40)}"}}\n`)
      const files = ['catalog/dsh-plugin.json', 'catalog/provenance.json']
      const tree = workingTreeWith(files, { root: work })
      assert.match(tree, /^[0-9a-f]{40}$/)
      assert.notEqual(tree, headTree, '工作区改了却编出与 HEAD 相同的树 ⇒ 改动会被静默丢掉')

      // 树里必须真的是**新**内容（而不是只有 sha 好看）。
      const list = git('ls-tree', '-r', tree)
      assert.match(list, /catalog\/dsh-plugin\.json/)
      const blob = git('show', `${tree}:catalog/dsh-plugin.json`)
      assert.match(blob, /b{40}/, '树里的 catalog 必须是工作区那份')
      // 且不该污染用户索引：HEAD 树没变、工作区改动仍在。
      assert.equal(git('rev-parse', 'HEAD^{tree}'), headTree, '不得改动 HEAD')
      assert.match(git('status', '--porcelain'), /catalog\/dsh-plugin\.json/)
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
  })

  check('第二段必须显式传工作区树（不能退回 HEAD^{tree}）', () => {
    // 静态守住调用点：`second` 那次 pushOneCommit 必须带 `tree:`。
    const call = /const second = await pushOneCommit\(\{[\s\S]{0,200}?\}\)/.exec(source)
    assert.ok(call !== null, '找不到第二段调用')
    assert.match(call[0], /tree:\s*secondTree/, '第二段必须显式传工作区树')
    assert.match(source, /workingTreeWith\(REVISION_TARGETS/, '必须用 REVISION_TARGETS 列出的文件编树')
  })

  check('推送后自证：git fetch 不可用时走 API 真查询，不得静默跳过', () => {
    assert.match(source, /verifyRemoteRevision\(/, '必须有推送后自证')
    // 真查询能力收在 lib 的带降级 helper 里：这里断言自证把「怎么问远端」交给它，
    // 而不是自己再写一套（写两套必然漂移）。helper 的降级行为由
    // scripts/catalog-revision-test.mjs 用真实仓库 + 假 fetch 验证。
    assert.match(source, /verifyRemoteRevision[\s\S]{0,500}?resolveRemoteReleaseRevision/,
      '自证必须走带真查询降级的 helper')
    assert.match(source, /resolveRemoteReleaseRevision\([\s\S]{0,300}?owner: OWNER/,
      '必须把 owner/repo/token 传下去，否则 helper 无法真查询')
    assert.ok(!/推送后自证跳过/.test(source), '不得存在「跳过自证」的静默路径')
  })
})()

/**
 * ── 远端 revision 的真查询（GitHub API）──────────────────────────────────
 *
 * 2026-10-21 实测：本机 git 传输被阻断，只剩「靠 diff 推断」；而推断在
 * **投影提交自身改了发布内容**（2.5.7 删渠道）时说不出真话。
 */
const fakeFetch = routes => async (url) => {
  const hit = Object.entries(routes).find(([key]) => url.includes(key))
  if (hit === undefined) return { ok: false, status: 404, json: async () => ({}) }
  const body = hit[1]
  if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => body }
}

/** 复用文件顶部已定义的 SHA_A / SHA_B（`a`×40 / `b`×40）。 */
const checkAsync = async (name, run) => {
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}

await (async () => {
  await checkAsync('真查询：单一路径命中 ⇒ 那个提交就是答案', async () => {
    const fetchImpl = fakeFetch({ '/commits?sha=main&path=package.json': [{ sha: SHA_A }] })
    const revision = await fetchRemoteReleaseRevision({
      branch: 'main', owner: 'o', repo: 'r', token: 't', paths: ['package.json'], fetchImpl,
    })
    assert.equal(revision, SHA_A)
  })

  await checkAsync('真查询：投影提交改了发布内容 ⇒ 返回投影提交自己（不是更早的重建提交）', async () => {
    // 场景回放（f04a6f4 vs 89f26ae）：squash 投影提交把 client.js / pack.js 全改了，
    // 于是每个路径的「最后触碰提交」都指向它。
    const fetchImpl = fakeFetch({
      '/commits?sha=main&path=client.js': [{ sha: SHA_B }],
      '/commits?sha=main&path=package.json': [{ sha: SHA_B }],
    })
    const revision = await fetchRemoteReleaseRevision({
      branch: 'main', owner: 'o', repo: 'r', token: 't',
      paths: ['package.json', 'client.js'], fetchImpl,
    })
    assert.equal(revision, SHA_B, '必须落在投影提交上')
  })

  await checkAsync('真查询：多候选按祖先关系定序（不靠日期）', async () => {
    const fetchImpl = fakeFetch({
      '/commits?sha=main&path=package.json': [{ sha: SHA_B }],
      '/commits?sha=main&path=client.js': [{ sha: SHA_A }],
      // base=A, head=B ⇒ B 更新
      [`/compare/${SHA_A}...${SHA_B}`]: { status: 'ahead' },
    })
    const revision = await fetchRemoteReleaseRevision({
      branch: 'main', owner: 'o', repo: 'r', token: 't',
      paths: ['package.json', 'client.js'], fetchImpl,
    })
    assert.equal(revision, SHA_B, 'B 在后 ⇒ 应当选 B')
  })

  await checkAsync('真查询：定序不了（diverged）⇒ 报错，绝不猜', async () => {
    const fetchImpl = fakeFetch({
      '/commits?sha=main&path=package.json': [{ sha: SHA_B }],
      '/commits?sha=main&path=client.js': [{ sha: SHA_A }],
      [`/compare/${SHA_A}...${SHA_B}`]: { status: 'diverged' },
    })
    await assert.rejects(() => fetchRemoteReleaseRevision({
      branch: 'main', owner: 'o', repo: 'r', token: 't',
      paths: ['package.json', 'client.js'], fetchImpl,
    }), /拒绝猜测/)
  })

  await checkAsync('真查询：查不到 / HTTP 失败 ⇒ 报错，不回退到猜测', async () => {
    // 查询成功但该路径没有任何提交 ⇒ 「找不到」。
    await assert.rejects(() => fetchRemoteReleaseRevision({
      branch: 'main', owner: 'o', repo: 'r', token: 't', paths: ['package.json'],
      fetchImpl: fakeFetch({ '/commits?sha=main&path=package.json': [] }),
    }), /找不到触碰发布内容的提交/)
    // HTTP 失败必须如实报出状态码，不能当成「没有提交」。
    await assert.rejects(() => fetchRemoteReleaseRevision({
      branch: 'main', owner: 'o', repo: 'r', token: 't', paths: ['package.json'],
      fetchImpl: fakeFetch({ '/commits?sha=main&path=package.json': 403 }),
    }), /HTTP 403/)
  })
})()

console.log(`api-push: ${failures === 0 ? 'all ok' : `${failures} failure(s)`}`)
process.exitCode = failures > 0 ? 1 : 0
