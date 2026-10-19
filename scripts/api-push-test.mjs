/**
 * `api-push-squash.mjs` 的两个易错点回归：**删除条目的 tree mode** 与
 * **API 错误提示**。
 *
 * ## 为什么需要它（2026-10-19 线上实锤）
 *
 * 推送差异里含删除文件时 `POST /git/trees` 返回 422 `Must supply a valid
 * tree.mode`：`git diff-tree` 的删除记录 newMode 是 `"000000"`，原实现原样
 * 发给 GitHub。当时**没有任何测试覆盖**这段解析 —— 它内联在一个带网络请求
 * 的循环里，线上才炸。故把解析抽成纯函数 `parseDiffTree` 并在这里直接喂
 * 字符串。
 *
 * Run: node scripts/api-push-test.mjs
 */
import assert from 'node:assert/strict'

const {
  parseDiffTree, describeApiError, DELETED_ENTRY_MODE,
} = await import('./api-push-squash.mjs')

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
    assert.match(source, /refreshCatalogRevision\(pushedSha\)/, '第二段的 revision 必须是刚推上去的 sha')
  })

  check('按同一套差异推送：删除条目 mode 仍走 DELETED_ENTRY_MODE', () => {
    // 两段式重构后，删除条目的归一必须在**共用的** pushOneCommit 里，
    // 否则第二段（只推 catalog/feed）虽不受影响，但第一段会退回 422。
    assert.match(source, /status === 'D'[\s\S]{0,80}entry\.mode/, '删除条目必须用 parseDiffTree 归一后的 mode')
  })
})()

console.log(`api-push: ${failures === 0 ? 'all ok' : `${failures} failure(s)`}`)
process.exitCode = failures > 0 ? 1 : 0
