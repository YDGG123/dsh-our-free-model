/**
 * 「发布内容的最后触碰提交」口径回归 —— `scripts/lib/catalog-revision.mjs`。
 *
 * ## 为什么要单独一套（而不是继续写在 cloud-sync-test 里）
 *
 * 这条口径 2026-10-19 / 10-20 连续踩了三次，每次都是**在错误的对象上算**：
 *
 * 1. 用**本地 HEAD**：squash 推送后该 sha 在远端不存在（API 404）；
 * 2. 用**推送后的 HEAD**：那个提交只碰 `catalog/`，真正碰发布内容的是它
 *    前面的产物重建提交（`c85e27e` vs `b005cb2`）；
 * 3. 用**推送前的 sha**：同上，只是换了时机。
 *
 * 前两次的修法都是「改一处调用点」，于是第三次又在另一个调用点复发了。
 * 这次把算法收进一个模块，并且**用真实 git 仓库**验证它，而不是用正则
 * 断源码里有没有某行 —— 正则只能证明「写了什么」，证明不了「算得对」。
 *
 * ## 覆盖的场景（每个都对应一次真实事故）
 *
 * - 发布内容之外的提交（README / catalog）**不移动** revision；
 * - 远端分支上重算：本地 HEAD 落后/超前时，答案仍取**远端**那个；
 * - 「推完内容后远端 HEAD 又前进」（catalog 刷新提交）⇒ revision 不变；
 * - fetch 不可用 ⇒ **抛错**，绝不返回猜测值；
 * - 空仓库 / 无发布内容提交 ⇒ **抛错**。
 *
 * Run: node scripts/catalog-revision-test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const lib = await import('./lib/catalog-revision.mjs')

let failures = 0
const check = (name, run) => {
  try { run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}
const checkAsync = async (name, run) => {
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}

const gitIn = (cwd, ...args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: 'pipe',
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    // 隔离用户级 / 系统级 git 配置（签名、hooks、默认分支名）。
    //
    // ⚠️ 本机（macOS）在**系统级**配置里也设了 `init.defaultBranch=main`，
    // 而 GitHub runner 上没有 —— 只隔离全局配置时，夹具在本机与云端行为不同
    // （2026-10-21 CI 实测：本地分支名差异导致套件在云端变红、本机全绿）。
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  },
}).trim()

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/**
 * 造一个最小的「插件仓库」：`package.json` 的 `files` 就是发布内容清单。
 * 目录结构与真实仓库无关 —— 被测的是 git 查询口径，不是仓库内容。
 */
function makeRepo(base) {
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  gitIn(repo, 'init', '-q', '-b', 'main')
  write(path.join(repo, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', files: ['src', 'client.js'],
  }, null, 2) + '\n')
  write(path.join(repo, 'client.js'), 'export const a = 1\n')
  write(path.join(repo, 'src', 'index.js'), 'export const b = 2\n')
  write(path.join(repo, 'README.md'), '# fixture\n')
  write(path.join(repo, 'catalog', 'dsh-plugin.json'), JSON.stringify({
    version: '1.0.0', source: { version: '1.0.0', revision: '0'.repeat(40) },
  }, null, 2) + '\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'release content')
  return repo
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-revision-'))
try {
  const repo = makeRepo(work)
  const contentSha = gitIn(repo, 'rev-parse', 'HEAD')

  // ── 基本口径：只统计 package.json + files ─────────────────────────────────

  check('发布内容提交 = 最后一次触碰 package.json/files 的提交', () => {
    assert.equal(lib.contentRevisionAt('HEAD', { root: repo }), contentSha)
  })

  check('只碰 README 的提交不移动 revision', () => {
    write(path.join(repo, 'README.md'), '# fixture v2\n')
    gitIn(repo, 'add', '-A')
    gitIn(repo, 'commit', '-q', '-m', 'docs only')
    assert.equal(lib.contentRevisionAt('HEAD', { root: repo }), contentSha,
      'README 不在 files 里，不该被算作发布内容')
  })

  check('只碰 catalog/ 的提交不移动 revision（刷新提交是幂等的）', () => {
    write(path.join(repo, 'catalog', 'dsh-plugin.json'), JSON.stringify({
      version: '1.0.0', source: { version: '1.0.0', revision: contentSha },
    }, null, 2) + '\n')
    gitIn(repo, 'add', '-A')
    gitIn(repo, 'commit', '-q', '-m', 'catalog: refresh revision')
    assert.equal(lib.contentRevisionAt('HEAD', { root: repo }), contentSha,
      'catalog 不属于发布内容，刷新提交不该让 revision 追自己')
  })

  check('碰了 client.js 的提交会移动 revision（files 列表生效）', () => {
    write(path.join(repo, 'client.js'), 'export const a = 3\n')
    gitIn(repo, 'add', '-A')
    gitIn(repo, 'commit', '-q', '-m', 'client change')
    const next = gitIn(repo, 'rev-parse', 'HEAD')
    assert.equal(lib.contentRevisionAt('HEAD', { root: repo }), next)
  })

  check('files 列表来自 package.json，不在代码里手写', () => {
    assert.deepEqual(lib.readReleaseContentPaths({ root: repo }), ['package.json', 'src', 'client.js'])
    // 改 package.json 的 files 后，判据随之变化 —— 证明没有第二份清单。
    write(path.join(repo, 'package.json'), JSON.stringify({
      name: 'fixture', version: '1.0.0', files: ['src'],
    }, null, 2) + '\n')
    gitIn(repo, 'add', '-A')
    gitIn(repo, 'commit', '-q', '-m', 'drop client.js from files')
    const after = gitIn(repo, 'rev-parse', 'HEAD')
    assert.equal(lib.contentRevisionAt('HEAD', { root: repo }), after)
    write(path.join(repo, 'package.json'), JSON.stringify({
      name: 'fixture', version: '1.0.0', files: ['src', 'client.js'],
    }, null, 2) + '\n')
    gitIn(repo, 'add', '-A')
    gitIn(repo, 'commit', '-q', '-m', 'restore files')
  })

  // ── 远端分支：这才是真正要写进 catalog 的值 ─────────────────────────────

  /**
   * 模拟真实事故现场：本地算出来的值**在远端不存在**（squash/新提交），
   * 或者本地 HEAD 又前进了（刷新提交）。唯一正确的是「远端分支上」的值。
   *
   * ⚠️ 全部 git 调用都必须走 `gitIn`（它隔离了用户/系统 git 配置），
   * 并且**显式指定分支名**：
   *
   * - `git init --bare` 不带 `-b` 时，bare 仓库的 HEAD 取决于
   *   `init.defaultBranch`（本机是 main、GitHub runner 上没有配置 ⇒ master）。
   *   2026-10-21 CI 实测：clone 出来的本地分支因此不是 main，
   *   下一句 `git push origin main:main` 报 `src refspec main does not match any`，
   *   整个套件在云端变红 —— 而本机永远绿。**夹具依赖开发机配置**就是这类事故。
   * - 推送一律写 `HEAD:main`，不去赌本地分支叫什么。
   */
  const origin = path.join(work, 'origin.git')
  gitIn(work, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  gitIn(repo, 'remote', 'add', 'origin', origin)
  gitIn(repo, 'push', '-q', 'origin', 'HEAD:main')
  const remoteContentSha = lib.contentRevisionAt('origin/main', { root: repo })

  await checkAsync('远端重算：fetch 后取 origin/<branch> 上的值', async () => {
    assert.equal(lib.remoteContentRevision('main', { root: repo }), remoteContentSha)
  })

  await checkAsync('推送后远端 HEAD 又前进（只碰 catalog）⇒ revision 不变', async () => {
    const before = lib.remoteContentRevision('main', { root: repo })
    // 模拟 api-push-squash 的第二段：只改 catalog 再推一次。
    write(path.join(repo, 'catalog', 'dsh-plugin.json'), JSON.stringify({
      version: '1.0.0', source: { version: '1.0.0', revision: before },
    }, null, 2) + '\n')
    gitIn(repo, 'add', '-A')
    gitIn(repo, 'commit', '-q', '-m', 'catalog: refresh revision over remote')
    gitIn(repo, 'push', '-q', 'origin', 'HEAD:main')
    const head = gitIn(repo, 'rev-parse', 'HEAD')
    assert.notEqual(head, before, '前置条件：远端 HEAD 应该已经前进')
    assert.equal(lib.remoteContentRevision('main', { root: repo }), before,
      '刷新提交不是发布内容 ⇒ 远端重算值必须不变（否则会无限追自己）')
  })

  await checkAsync('本地 HEAD 落后远端时，仍取远端值（不能信任本地）', async () => {
    // 远端再往前走一个**碰发布内容**的提交，本地不动。
    const clone = path.join(work, 'other')
    gitIn(work, 'clone', '-q', '-b', 'main', origin, 'other')
    write(path.join(clone, 'src', 'index.js'), 'export const b = 9\n')
    gitIn(clone, 'add', '-A')
    gitIn(clone, 'commit', '-q', '-m', 'remote content change')
    gitIn(clone, 'push', '-q', 'origin', 'HEAD:main')
    const remoteHead = gitIn(clone, 'rev-parse', 'HEAD')

    const localValue = lib.contentRevisionAt('HEAD', { root: repo })
    const remoteValue = lib.remoteContentRevision('main', { root: repo })
    assert.equal(remoteValue, remoteHead, '远端重算必须看到远端的新提交')
    assert.notEqual(remoteValue, localValue, '本地值此时已经过期 —— 这正是事故现场')
  })

  // ── 拿不到真相时必须报错，绝不猜 ─────────────────────────────────────────

  await checkAsync('fetch 失败 ⇒ 抛错（不返回猜测值）', async () => {
    assert.throws(
      () => lib.remoteContentRevision('branch-that-does-not-exist', { root: repo }),
      /fetch .* 失败/,
    )
  })

  check('空仓库 / 无发布内容提交 ⇒ 抛错', () => {
    const empty = path.join(work, 'empty')
    fs.mkdirSync(empty, { recursive: true })
    gitIn(empty, 'init', '-q', '-b', 'main')
    write(path.join(empty, 'README.md'), '# nothing shipped\n')
    gitIn(empty, 'add', '-A')
    gitIn(empty, 'commit', '-q', '-m', 'docs')
    assert.throws(() => lib.contentRevisionAt('HEAD', { root: empty }), /读不到 .*package\.json/)
  })

  check('package.json 存在但发布内容没有提交 ⇒ 抛错，不返回空串', () => {
    // 提交历史里 package.json 从未被提交（只在工作区）⇒ git log 返回空。
    const fresh = path.join(work, 'fresh')
    fs.mkdirSync(fresh, { recursive: true })
    gitIn(fresh, 'init', '-q', '-b', 'main')
    write(path.join(fresh, 'README.md'), '# docs\n')
    gitIn(fresh, 'add', '-A')
    gitIn(fresh, 'commit', '-q', '-m', 'docs only')
    write(path.join(fresh, 'package.json'), JSON.stringify({ name: 'x', files: ['src'] }, null, 2) + '\n')
    assert.throws(() => lib.contentRevisionAt('HEAD', { root: fresh }), /找不到发布内容的提交/)
  })

  check('sha 形态校验：短 sha / 大写必须被拒', () => {
    assert.equal(lib.SHA_PATTERN.test('a'.repeat(40)), true)
    assert.equal(lib.SHA_PATTERN.test('a'.repeat(39)), false)
    assert.equal(lib.SHA_PATTERN.test('A'.repeat(40)), false)
    assert.equal(lib.SHA_PATTERN.test(''), false)
  })

  // ── catalogRevision：自证用的读取器 ──────────────────────────────────────

  check('catalogRevision 读得到（且读不到时返回 undefined，不抛）', () => {
    write(path.join(repo, 'catalog', 'dsh-plugin.json'), JSON.stringify({
      version: '1.0.0', source: { version: '1.0.0', revision: contentSha },
    }, null, 2) + '\n')
    assert.equal(lib.catalogRevision({ root: repo }), contentSha)
    assert.equal(lib.catalogRevision({ root: path.join(work, 'nope') }), undefined)
  })

  // ── isReleaseContentPath：判定「这次推送有没有动发布内容」 ────────────────

  check('isReleaseContentPath 认目录前缀与文件本身，拒绝相邻同名前缀', () => {
    const paths = ['package.json', 'src', 'client.js']
    assert.equal(lib.isReleaseContentPath('package.json', paths), true)
    assert.equal(lib.isReleaseContentPath('src/index.js', paths), true)
    assert.equal(lib.isReleaseContentPath('src', paths), true)
    assert.equal(lib.isReleaseContentPath('client.js.map', paths), false)
    assert.equal(lib.isReleaseContentPath('catalog/dsh-plugin.json', paths), false)
    assert.equal(lib.isReleaseContentPath('README.md', paths), false)
  })
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

console.log(`catalog-revision: ${failures === 0 ? 'all ok' : `${failures} failure(s)`}`)
process.exitCode = failures > 0 ? 1 : 0
