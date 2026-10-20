/**
 * 定时把上游 Ebony-Vinyl/dsh-our-free-model 的更新合并进本 fork 并发布。
 *
 * ## 设计目标
 *
 * 用户对 fork 的要求：「上游更新了，自动拿来，把我们修改过的功能加进去，
 * 上游更新的功能我们用的上，我们自己添加的功能也用的上。」本脚本是这个
 * 要求的自动化实现，由 launchd 每日触发（也可手动运行）。
 *
 * ## 流程
 *
 * 1. `git fetch upstream`（remote 已指向 gh-proxy 镜像；公开仓库拉取无需
 *    认证 —— 本机 github.com:443 被阻断，详见 docs/FORK.md）。
 * 2. 上游 main 已是本地祖先 → 更新状态文件退出（无事可做）。
 * 3. 工作区必须干净（脏树直接退出 —— 宁可不同步也不覆盖未提交的改动）。
 * 4. `git merge upstream/main`：
 *    - 冲突文件**全部**属于生成产物（feed/manifest.json、catalog/*、
 *      vendor/channel-pack/pack.js）→ 取 ours 后重建/重签，内容总是对的；
 *    - 出现生成产物以外的冲突 → abort 并报错，**留待人工处理**
 *      （自动化只承诺干净合并；真冲突需要人判断）。
 * 5. 重建 pack.js（上游若改了 vendor 源码，旧产物就过期了）。
 * 6. catalog revision 跟随「最后触碰发布文件的提交」，重签 manifest。
 * 7. 跑目标测试集；失败 → reset 回合并前并报错（已推送的内容不受影响）。
 * 8. `api-push-squash.mjs` 推送到 fork；更新状态文件。
 *
 * ## 用法
 *
 *     node scripts/sync-upstream.mjs             # 同步 + 重建 + 回归，**不推送**
 *     node scripts/sync-upstream.mjs --push      # 同上，最后再推送到 fork
 *     node scripts/sync-upstream.mjs --dry-run   # 到推送前一步为止（--push 时才有意义）
 *
 * ## ⚠️ 默认**不推送**（2026-10-19 改）
 *
 * 旧实现无条件 push 到 fork。但「同步上游」与「发布我的 fork」是两件事：
 * 前者是本地仓库的日常维护（跑完看回归结果就该结束），后者会改变所有安装了
 * 本 fork 的用户的升级源。把它们绑死意味着**任何一次上游同步都会立刻对外发布**，
 * 而且推上去之后就没有「先看看合并结果」的机会了。
 *
 * 现在推送必须显式 `--push`。launchd 的定时任务若要保留自动发布语义，
 * 需要在 plist 的 ProgramArguments 里加上 `--push`（不自动改用户的定时任务）。
 *
 * GH_TOKEN 从环境变量或 `.private/gh-token` 读取（仅 `--push` 需要；拉取不需要）。
 *
 * ## `--ci`：给 GitHub Actions 用的模式（Mac 不开机也能跑）
 *
 * 与本地模式的差异**只有三处**，其余（合并策略、生成产物取 ours、重建
 * pack.js、刷新 revision、测试集）**完全共用同一份代码** —— 绝不抄第二份：
 *
 * | 方面 | 本地 | `--ci` |
 * |---|---|---|
 * | 推送 | `api-push-squash.mjs`（本机 git 传输到 github 被阻断） | 常规 `git push`（runner 直连没问题） |
 * | 推送目标 | 远端 `main`（squash 成单提交） | 同样 `main`：**保持与本机一致的发布语义** |
 * | 签名密钥 | `.private/ofm-release-key.pem` | `OFM_RELEASE_KEY` 指向 runner 临时文件 |
 * | 状态文件 | `.private/upstream-sync-state.json` | 不需要（每次全新 checkout，靠 `merge-base` 判断） |
 * | 失败 | 回滚本地 | 回滚 + 写 `.private/sync-failure.json` 到 fork（供本机通知桥读） |
 *
 * ⚠️ **云端不自己重签**：`main` 上已有上游的 `release-sign.yml`，它在 push 后
 * 自动重签并刷新 revision。本脚本在 `--ci` 下仍会刷新 revision 与重签（保证
 * 推上去的内容自洽、测试能过），但如果密钥缺失则**跳过重签**并交给那个
 * workflow —— 见 `--ci` 下的密钥处理。
 *
 * ## 状态与日志
 *
 * - 上游游标：`.private/upstream-sync-state.json`（机器状态，不入库）
 * - 日志：调用方重定向（launchd plist 写 `.private/sync.log`）
 *
 * @module scripts/sync-upstream.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const statePath = path.join(root, '.private', 'upstream-sync-state.json')
const tokenPath = path.join(root, '.private', 'gh-token')
const keyPath = process.env.OFM_RELEASE_KEY ?? path.join(root, '.private', 'ofm-release-key.pem')

const dryRun = process.argv.includes('--dry-run')
/** 只有显式 `--push` 才会推送（见头注「默认不推送」）。 */
const shouldPush = process.argv.includes('--push')
/**
 * `--ci`：GitHub Actions 模式（见头注的差异表）。`--ci` **隐含推送**
 * —— 云端跑这一趟的意义就是发布；失败路径由 workflow 负责写状态文件。
 */
const ciMode = process.argv.includes('--ci')
const willPush = shouldPush || ciMode
/**
 * 取一个带值的命令行参数（`--name value`），缺省返回 `undefined`。
 *
 * ## ⚠️ 这个函数曾经被调用却没有定义（真实缺陷，2026-10-19 Tester 实测发现）
 *
 * 失败路径里 `const failFile = flag('fail-file')` 直接抛
 * `TypeError: flag is not a function`，而这行在 `catch` 块里、回滚**之后**
 * —— 于是「云端失败 ⇒ 写状态文件 ⇒ 本机弹通知」这条链路在第一步就断，
 * 用户只会看到「失败了，原因未知」。`cloud-sync-test` 当时 17/17 全绿也没
 * 抓到，因为它只测了 report/check 两个脚本，没测本脚本的 `--fail-file`。
 *
 * 语义与 `api-push-squash.mjs` 里的同名实现一致（那边一直是对的）。
 */
const flag = name => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** ⚠️ 不要在这里手写「发布内容」清单：revision 判据必须与 catalog-test /
 * prepare-release 用同一算法（`package.json` + 其 `files` 列表）。
 * 手写清单会与 `package.json.files` 漂移，release 模式的 catalog-test 立刻变红。 */

/** 冲突时可以安全「取 ours」的生成产物（随后重建/重签，内容总是正确的）。 */
/**
 * 冲突时可以安全「取 ours」的**生成产物**（随后重建/重签，内容总是正确）。
 *
 * ⚠️ `packages/standalone/web/**` 必须在这里（2026-10-19 云端 dry-run 实测）：
 * 那是独立端的**构建产物**（`app.js` / `assets.json` / 带 hash 的分包），
 * 上游每次发版都会重新生成、hash 也会变。把它们当源码去三方合并必然冲突
 * （rename/delete、modify/delete 轮番出现），而正确做法永远是
 * **取 ours + 合并后重建**（`build-standalone-ui.mjs`）。
 */
const GENERATED = new Set([
  'feed/manifest.json',
  'catalog/integrity.json',
  'catalog/dsh-plugin.json',
  'catalog/provenance.json',
  'vendor/channel-pack/pack.js',
])

/** 生成产物里按**目录前缀**判定的（`packages/standalone/web/` 下全是产物）。 */
const GENERATED_PREFIXES = [
  'packages/standalone/web/',
]

/** 是否属于「可以取 ours 再重建」的生成产物。 */
export function isGeneratedPath(filePath) {
  if (GENERATED.has(filePath)) return true
  return GENERATED_PREFIXES.some(prefix => filePath.startsWith(prefix))
}

/** 合并后必须通过的目标测试集（全量 test-all 中已知稳定通过的部分；
 * reload 套件在上游纯净分支同样失败，属上游与 Node 24 的兼容问题，不列入）。 */
/**
 * 测试集。可用 `OFM_SYNC_TESTS`（逗号分隔）覆盖 —— **只为离线回归而开**：
 * `scripts/cloud-sync-test.mjs` 需要跑一个「必定失败」的场景来验证
 * `--fail-file` 真的写得出状态文件，而全量测试集要几分钟且不该故意挂。
 *
 * ⚠️ 生产路径（launchd / GitHub Actions）不设这个变量，行为不变。
 */
const TESTS = process.env.OFM_SYNC_TESTS !== undefined && process.env.OFM_SYNC_TESTS.trim() !== ''
  ? process.env.OFM_SYNC_TESTS.split(',').map(item => item.trim()).filter(Boolean)
  : [
  'scripts/raccoon-balance-test.mjs',
  'scripts/updater-test.mjs',
  'scripts/catalog-test.mjs',
  'scripts/chan-relay-test.mjs',
  'scripts/feed-test.mjs',
  'scripts/picks-test.mjs',
  // ⚠️ 补进来的两个：它们跑的是**真实源码/真实产物**，上游一改就会挂 ——
  // 首次同步演练正是被它们抓到的（上游 2.5.4 给 app.tsx 新引了 SponsorPage /
  // SponsorNotice，测试桩没跟上；另一条是 catalog 版本号没跟随）。
  'scripts/standalone-page-lifecycle-test.mjs',
  'scripts/channel-pack-test.mjs',
  'scripts/raccoon-daily-grant-test.mjs',
  'scripts/credit-usage-test.mjs',
  'scripts/credit-sampling-test.mjs',
]

const say = message => console.log(`[${new Date().toISOString()}] ${message}`)
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 512 * 1024 * 1024 }).toString()
const run = (command, args, env = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, ...env } })
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** git 身份：从既有提交读取（launchd 环境里没有 shell 的 git 配置）。 */
const identity = (() => {
  const [name, email] = git('log', '-1', '--format=%an|%ae').trim().split('|')
  return { name: name || 'YDGG123', email: email || 'YDGG123@users.noreply.github.com' }
})()
const GIT_ENV = {
  GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
  GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch { return {} }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}

/**
 * 失败出口：写状态文件（若给了 `--fail-file`）、打日志、以 1 退出。
 *
 * ## 为什么所有失败路径都必须走这里（真实缺陷，2026-10-19）
 *
 * 最初只有 `catch` 块末尾写状态文件，于是**三条早期退出路径**全都写不出来：
 * `fetch 失败`、`工作区不干净`、`合并冲突`（后两者是 `process.exit(1)` 直接退，
 * 根本不进 catch）。而 `fetch 失败` 恰恰是云端最常见的一种失败（网络/鉴权）。
 *
 * 云端 workflow 依赖这个文件给用户「原因」，缺失时只能报「未知失败」——
 * 那等于通知白做。故：**任何非零退出都要先经过这里**。
 */
function failOut(step, message, extra) {
  say(`❌ ${message}`)
  const failFile = flag('fail-file')
  if (failFile !== undefined) {
    try {
      const payload = {
        failedAt: new Date().toISOString(),
        failedStep: step,
        message,
        upstreamHead: extra?.upstreamHead ?? '',
        preMergeHead: extra?.preMergeHead ?? '',
        headAtFailure: extra?.headAtFailure ?? '',
        conflictedFiles: extra?.conflictedFiles ?? [],
        runUrl: process.env.GITHUB_RUN_URL ?? '',
      }
      fs.writeFileSync(failFile, JSON.stringify(payload, null, 2) + '\n')
      say(`失败信息已写入 ${failFile}`)
    } catch (error) {
      // 写不出来也不能掩盖原始失败：记一行，继续以 1 退出。
      say(`⚠️ 失败信息写入 ${failFile} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  process.exit(1)
}

/** 把失败消息归到「哪一步」——通知里要能一眼看出是冲突还是测试挂。 */
function classifyFailure(message) {
  if (/需要人工判断的冲突|CONFLICT|Merge conflict/i.test(message)) return 'merge-conflict'
  if (/测试失败|[Tt]est failed/i.test(message)) return 'test-failed'
  if (/签名|sign/i.test(message)) return 'sign-failed'
  if (/重建|build/i.test(message)) return 'build-failed'
  if (/推送|push/i.test(message)) return 'push-failed'
  return 'unknown'
}

async function main() {
  say(`sync-upstream 开始${dryRun ? '（--dry-run）' : ''}`)

  // ── 1. 拉上游（镜像免认证） ─────────────────────────────────────────────
  say('fetch upstream …')
  const fetched = run('git', ['fetch', '--force', 'upstream', 'main:refs/remotes/upstream/main'])
  if (fetched.code !== 0) {
    failOut('fetch-failed', `fetch 失败：${fetched.output.slice(0, 300)}`)
  }
  const upstreamHead = git('rev-parse', 'refs/remotes/upstream/main').trim()
  say(`上游 main = ${upstreamHead.slice(0, 7)}`)

  // ── 2. 已是祖先 → 无事可做 ──────────────────────────────────────────────
  const isAncestor = run('git', ['merge-base', '--is-ancestor', upstreamHead, 'HEAD']).code === 0
  const lastSynced = readState().lastUpstreamSha
  if (isAncestor && lastSynced === upstreamHead) {
    say('✅ 上游无新提交，退出')
    return
  }
  if (isAncestor) {
    say('上游提交已在本地历史中，仅更新游标')
    writeState({ lastUpstreamSha: upstreamHead })
    say('✅ 完成')
    return
  }

  // ── 3. 工作区必须干净 ──────────────────────────────────────────────────
  const dirty = git('status', '--porcelain').trim()
  if (dirty !== '') {
    failOut('dirty-worktree', `工作区不干净，放弃本次同步（不覆盖未提交改动）：\n${dirty}`)
  }
  const preMergeHead = git('rev-parse', 'HEAD').trim()
  say(`合并前 HEAD = ${preMergeHead.slice(0, 7)}`)

  // ── 4. 合并 ────────────────────────────────────────────────────────────
  // merge commit 信息里写清同步自上游哪个 commit（`--no-edit` 只会给一句
  // 泛泛的 "Merge remote-tracking branch …"，排障时还得考古）。
  const mergeMessage = [
    `Merge upstream/main (${upstreamHead.slice(0, 7)}) into ${git('rev-parse', '--abbrev-ref', 'HEAD').trim()}`,
    '',
    '同步上游更新；本 fork 的自有功能以 merge 方式保留（不改写已有 commit）。',
  ].join('\n')
  const merged = run('git', ['merge', '--no-ff', '-m', mergeMessage, upstreamHead], GIT_ENV)
  if (merged.code !== 0) {
    const conflicted = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)
    const unresolvable = conflicted.filter(file => !isGeneratedPath(file))
    if (conflicted.length === 0 || unresolvable.length > 0) {
      run('git', ['merge', '--abort'])
      failOut(
        'merge-conflict',
        `存在需要人工判断的冲突，已回滚合并，留待处理：\n${unresolvable.join('\n')}`,
        { upstreamHead, conflictedFiles: unresolvable },
      )
    }
    // 生成产物冲突：取 ours（随后重建/重签，内容总是正确的）。
    for (const file of conflicted) {
      run('git', ['checkout', '--ours', '--', file])
      run('git', ['add', file])
      say(`  冲突取 ours：${file}（生成产物，稍后重建）`)
    }
    const resolved = run('git', ['commit', '--no-edit'], GIT_ENV)
    if (resolved.code !== 0) {
      run('git', ['merge', '--abort'])
      failOut('merge-commit-failed', `冲突解决后提交失败：${resolved.output.slice(0, 200)}`, { upstreamHead })
    }
  }
  const mergedHead = git('rev-parse', 'HEAD').trim()
  say(`合并完成 → ${mergedHead.slice(0, 7)}`)
  /** 是否真的重签了（推送段与 --check 段都要用，故提到 try 之外）。 */
  let signedRelease = false
  /** 本次失败时的结构化信息（`--ci` 下由 workflow 写成状态文件）。 */
  let failure = null

  try {
    // ── 5. 重建 pack.js（上游改过 vendor 源码时旧产物已过期） ─────────────
    say('重建 vendor/channel-pack/pack.js …')
    const built = run('node', ['scripts/build-channel-pack.mjs'])
    if (built.code !== 0) throw new Error(`pack 重建失败：${built.output.slice(0, 300)}`)
    if (git('status', '--porcelain', '--', 'vendor/channel-pack/pack.js').trim() !== '') {
      run('git', ['add', 'vendor/channel-pack/pack.js'])
      const committed = run('git', ['commit', '-m', `build(channel-pack): 重建上游合并后的产物`], GIT_ENV)
      if (committed.code !== 0) throw new Error('pack 提交失败')
      say('  pack.js 已重建并提交')
    } else {
      say('  pack.js 无变化')
    }

    /**
     * ── 5b. 重建独立端产物（`packages/standalone/web/**`）──
     *
     * 这些是**构建产物**（`app.js` / `assets.json` / 带 hash 的分包）。
     * 合并时我们「取 ours」保留了本 fork 的版本，但我们的 `client.js` 改动
     * 嵌在独立端包里 ⇒ 取 ours 之后它与当前 `client.js` **已经不一致**，
     * 云端 `build-standalone-ui --check` 会报「需要重新生成」。
     *
     * 重建后它们与源码自洽。注意这些文件**不在** `package.json` 的 `files`
     * 里，不进发布清单，故不需要重签 manifest。
     */
    say('重建独立端产物（packages/standalone/web）…')
    const builtUi = run('node', ['scripts/build-standalone-ui.mjs'])
    if (builtUi.code !== 0) {
      // 独立端构建依赖 vite（`packages/standalone` 的 devDependency）。
      // 云端装了依赖，本地可能没装 —— 记清楚，不要伪装成通过。
      throw new Error(`独立端重建失败：${builtUi.output.slice(-1200)}`)
    }
    const standaloneDirty = git('status', '--porcelain', '--', 'packages/standalone/web').trim()
    if (standaloneDirty !== '') {
      run('git', ['add', 'packages/standalone/web'])
      const committed = run('git', ['commit', '-m', 'build(standalone): 重建上游合并后的独立端产物'], GIT_ENV)
      if (committed.code !== 0) throw new Error('独立端产物提交失败')
      say('  独立端产物已重建并提交')
    } else {
      say('  独立端产物无变化')
    }

    // ── 6. catalog revision + 重签 ────────────────────────────────────────
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    /**
     * `contentRevision` 必须与 **catalog-test / prepare-release 用同一算法**：
     * 「最后一次触碰发布内容（`package.json` + 其 `files` 列表）的提交」。
     *
     * ⚠️ 不能自己另列一份手写清单 —— 上游一改
     * `package.json` 的 `files`，两份就会漂移，`catalog-test`（release 模式）
     * 立刻报 `source revision is the last commit that touched the release
     * content`。首次同步演练正是踩了类似的坑（漏刷新整个 revision）。
     *
     * 只统计发布内容、**不含** `catalog/` 与 `feed/` ⇒ 本脚本随后的签名提交
     * 不会移动这个指针，不存在「永远追不上自己」的循环。
     */
    const contentRevision = git('log', '-1', '--format=%H', '--', 'package.json', ...(pkg.files ?? [])).trim()
    for (const [file, key] of [['catalog/dsh-plugin.json', 'revision'], ['catalog/provenance.json', 'sourceRevision']]) {
      const doc = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
      const target = file.includes('dsh-plugin') ? doc.source : doc.subject
      target.version = pkg.version
      target[key] = contentRevision
      /**
       * ⚠️ **真实缺陷（2026-10-19 首次同步演练踩到）**：`catalog/dsh-plugin.json`
       * 有**两个** version —— 顶层 `version`（清单自身）与 `source.version`
       * （指向哪个上游版本）。旧实现只改 `source.version`，于是上游把
       * package.json 升到 2.5.4 后，`catalog-test` 报
       * `version tracks package.json — got "2.5.2", want "2.5.4"`。
       */
      if (file.includes('dsh-plugin')) doc.version = pkg.version
      fs.writeFileSync(path.join(root, file), JSON.stringify(doc, null, 2) + '\n')
    }
    say(`catalog → ${pkg.version} @ ${contentRevision.slice(0, 7)}`)
    /**
     * ## 重签：本地必做，云端可交给 `release-sign.yml`
     *
     * 本地有私钥文件 ⇒ 直接重签（产物自洽、`catalog-test` 能过）。
     *
     * 云端（`--ci`）密钥来自 secret，正常情况下也有；但**若没配密钥**，
     * 这里不硬失败而是**跳过重签**：`main` 上已有的 `release-sign.yml` 会在
     * push 后自动重建 + 重签（它自己会跑 `build-manifest --check` 判断漂移，
     * 并 `refresh-revision.mjs`）。硬失败只会让「没配签名密钥的 fork」完全
     * 同步不了，收益为负。
     *
     * ⚠️ 跳过时**不能**让后续 `build-manifest --check` 变成必过项（旧清单
     *  describ 的是旧树）—— 见下面测试段的同一开关。
     */
    const hasKey = fs.existsSync(keyPath)
    if (!hasKey && !ciMode) throw new Error(`release signing key not found at ${keyPath} (set OFM_RELEASE_KEY)`)
    if (!hasKey) {
      say('⚠️ 未找到签名密钥：跳过重签，交由 main 上的 release-sign.yml 处理')
    } else {
      const signed = run('node', ['scripts/build-manifest.mjs', '--key', keyPath])
      if (signed.code !== 0) throw new Error(`manifest 签名失败：${signed.output.slice(0, 300)}`)
      run('git', ['add', 'feed/manifest.json', 'catalog/integrity.json', 'catalog/dsh-plugin.json', 'catalog/provenance.json'])
      const signCommit = run('git', ['commit', '-m', `catalog: sign the release over ${contentRevision.slice(0, 7)}`], GIT_ENV)
      if (signCommit.code !== 0) throw new Error('签名提交失败')
      say('manifest 已重签并提交')
      signedRelease = true
    }

    // ── 7. 测试 ───────────────────────────────────────────────────────────
    say('运行目标测试集 …')
    for (const test of TESTS) {
      const result = run('node', [test])
      const passed = result.code === 0
      say(`  ${passed ? '✅' : '❌'} ${path.basename(test)}`)
      if (!passed) throw new Error(`测试失败：${test}\n${result.output.slice(-1500)}`)
    }
    // 清单与树的字节一致性：签过名才可校验（跳过重签时旧清单描述的是旧树）。
    if (signedRelease) {
      const check = run('node', ['scripts/build-manifest.mjs', '--check'])
      if (check.code !== 0) throw new Error(`manifest --check 失败：${check.output.slice(0, 300)}`)
      say('  ✅ build-manifest --check')
    } else {
      say('  ⏭  跳过 build-manifest --check（未重签，清单描述的是旧树）')
    }

    // ── 8. 推送 + 游标 ────────────────────────────────────────────────────
    if (dryRun || !willPush) {
      say(dryRun
        ? '--dry-run：到推送前为止，不推送'
        : '未指定 --push/--ci：同步与回归已完成，**不推送**（看结果满意后再 `--push` 或手动推）')
      say(`本地 HEAD = ${git('rev-parse', 'HEAD').trim().slice(0, 7)}`)
      // 游标仍要前移：否则下次会把同一批上游提交重新合并一遍（虽然幂等，
      // 但会多出一次空 merge commit）。
      writeState({ lastUpstreamSha: upstreamHead })
      return
    }
    /**
     * ## 推送：本地走 API squash，云端走常规 git push
     *
     * - **本地**：`github.com:443` 的 git 传输被阻断，只能用
     *   `api-push-squash.mjs`（逐 blob 走 REST API）。
     * - **云端（`--ci`）**：runner 直连 github 没问题，用常规 `git push` 更简单
     *   也更不容易出意外。**目标分支同样是 `main`** —— 与本机推送语义保持一致
     *   （`main` 是发布分支，内容 = 完整历史压扁成单提交；完整历史留在
     *   `custom-main`，云端 checkout 的就是它）。
     */
    if (ciMode) {
      /**
       * ## 云端：推送 + **二次刷新 revision**
       *
       * ### 为什么要推两次（真实故障，2026-10-19 run 39244615254）
       *
       * catalog 的 `source.revision` 必须等于「最后一次触碰发布内容的提交」。
       * 本地算出来的是**本地** commit（如 `524f972`）；推送之后远端多出的是
       * **新** commit（远端 `main` 是 squash/独立历史，本地 sha 在远端根本
       * 不存在 —— 实测 `GET /git/commits/524f972` 返回 404）。
       *
       * 于是 `main` 上的 `release-sign.yml` 触发后：
       *   - `build-manifest --check` **通过**（字节一致）⇒ 刷新分支不进入；
       *   - 紧接着 `test-all --mode release` 的 `catalog-test` 报
       *     `source revision ... got "524f972…", want "82904ed…"` ⇒ 红。
       *
       * 修法：push 之后**再算一次** revision（这时指向的是远端真实 commit），
       * 写进 catalog 再推一次。第二次推送只改 `catalog/` 与 `feed/`，不会
       * 移动 revision 指针本身（该指针只统计发布内容），所以不会循环。
       */
      /**
       * ## 云端推送：**两个分支**（2026-10-19 结构性修正）
       *
       * ### 为什么必须基于 custom-main 工作
       *
       * 远端 `main` 是 **squash 历史**：它和上游的共同祖先停在 v2.5.4 之前。
       * 拿它当合并基底，三方合并的基准太旧 ⇒ 上游 2.5.4+2.5.5 的全部改动
       * 和本 fork 的 squash 改动被摆在一起对撞，**必然出现大量「需人工判断」
       * 的冲突**（云端 dry-run 实测 10 个文件，含 README / client.js /
       * package.json / standalone/*）。
       *
       * 而 `custom-main` 有**完整的上游祖先**（昨天合并 2.5.4 就是零冲突的
       * 证明）。故云端改为：
       *
       *   checkout custom-main → merge upstream → 测试 → 推 custom-main → squash 推 main
       *
       * `custom-main` 是**事实源**，`main` 只是它的发布投影。
       */
      const workBranch = process.env.OFM_WORK_BRANCH ?? 'custom-main'
      const releaseBranch = process.env.OFM_PUSH_BRANCH ?? 'main'
      const pushBranch = process.env.OFM_PUSH_BRANCH_ONLY !== '1'

      // ── ① 推 custom-main（**完整历史**，常规 git push，绝不 squash）──
      //    合并基线必须是带上游祖先的完整历史；squash 会把祖先压掉，
      //    下一次合并又退化成「基准太旧」。
      say(`推送 HEAD → origin/${workBranch}（--ci，完整历史）…`)
      const workRef = run('git', ['rev-parse', '--verify', '--quiet', `origin/${workBranch}`])
      if (workRef.code === 0) {
        const remoteSha = workRef.output.trim()
        if (run('git', ['merge-base', '--is-ancestor', remoteSha, 'HEAD']).code !== 0) {
          say(
            `⚠️ 本地 HEAD 不是 origin/${workBranch} 的后代（远端 ${remoteSha.slice(0, 7)}）。\n`
            + '  云端 runner 每次都是全新 checkout（HEAD 即该分支），故是快进推送。\n'
            + '  本机用 --ci 试跑时若 HEAD 与该分支不一致，请改用 `--push`。',
          )
          throw new Error(`HEAD 不是 origin/${workBranch} 的后代，拒绝推送`)
        }
      }
      const pushedWork = run('git', ['push', 'origin', `HEAD:${workBranch}`])
      say(pushedWork.output.trim().slice(-1500))
      if (pushedWork.code !== 0) throw new Error(`推送 ${workBranch} 失败`)
      const workHead = run('git', ['rev-parse', `origin/${workBranch}`]).output.trim()
      say(`  ✅ ${workBranch} -> ${workHead.slice(0, 7)}`)

      // ── ② 刷新 revision：**重算**「最后触碰发布内容的提交」 ──
      //
      // ## ⚠️ 不能用推送后的 HEAD（真实缺陷，2026-10-20 云端正式跑撞出）
      //
      // 旧实现把 revision 设成 `workHead`（刚推上去的那个提交）。但那一轮里
      // 我们**先**有 `build(channel-pack): 重建…`（碰了 `pack.js` = 发布内容），
      // **之后**才提交 catalog（只碰 `catalog/`）。于是：
      //
      //   c85e27e  build(channel-pack): 重建上游合并后的产物   ← 真正碰了发布内容
      //   b005cb2  catalog: sign the release over c85e27e      ← 只碰 catalog
      //   workHead = b005cb2  ⇒ 写成 revision 后**立刻就是错值**
      //   effce98  catalog: refresh revision over b005cb2      ← 这一笔把对的改错了
      //
      // 云端报 `got "b005cb2", want "c85e27e"` 正是这个。
      //
      // 修法：**必须与 catalog-test 用同一算法**——在该分支上跑
      // `git log -1 -- <package.json + pkg.files>`。HEAD 是不是那个提交无关紧要。
      say('刷新 catalog revision（重算「最后触碰发布内容的提交」）…')
      const filesForRevision = (() => {
        try {
          const manifestPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
          return ['package.json', ...(manifestPkg.files ?? [])]
        } catch { return ['package.json'] }
      })()
      const contentRevision = git('log', '-1', '--format=%H', '--', ...filesForRevision).trim()
      if (!/^[0-9a-f]{40}$/.test(contentRevision)) {
        throw new Error('无法解析「最后触碰发布内容的提交」，拒绝写入猜测值')
      }
      say(`  最后触碰发布内容 = ${contentRevision.slice(0, 7)}（HEAD 是 ${workHead.slice(0, 7)}）`)
      const refreshed = run('node', ['scripts/set-catalog-revision.mjs', contentRevision])
      say(refreshed.output.trim().slice(-800))
      if (refreshed.code !== 0) throw new Error('刷新 revision 失败')

      // ── ③ 把刷新后的 revision 再推一次 custom-main（快进）──
      const dirtyCatalog = git('status', '--porcelain', '--', 'catalog', 'feed').trim()
      if (dirtyCatalog !== '') {
        run('git', ['add', 'catalog', 'feed'])
        const committed = run('git', ['commit', '-m', `catalog: refresh revision over ${contentRevision.slice(0, 7)}`], GIT_ENV)
        if (committed.code !== 0) throw new Error('revision 刷新提交失败')
        const repushedWork = run('git', ['push', 'origin', `HEAD:${workBranch}`])
        say(repushedWork.output.trim().slice(-800))
        if (repushedWork.code !== 0) throw new Error(`二次推送 ${workBranch} 失败`)
        say('  ✅ revision 已刷新并推送')
      } else {
        say('  revision 已正确，无需二次推送')
      }

      if (!pushBranch) {
        say(`OFM_PUSH_BRANCH_ONLY=1：跳过 ${releaseBranch} 的投影推送`)
        writeState({ lastUpstreamSha: upstreamHead })
        return
      }

      // ── ④ 把工作分支投影到发布分支 `main` ──
      //
      // ## 两种形态，由 `OFM_MAIN_SYNC_MODE` 选择（默认 `history`）
      //
      // - `history`（推荐，2026-10-19 起）：`main` 与上游同形 —— **常规历史**。
      //   用 `force-with-lease` 把 `custom-main` 推上去。好处是 revision 口径
      //   在全仓统一（`git log -1 -- <发布内容>` 在任何分支都成立），
      //   且以后合并上游不再需要「两段式刷新」这套 squash 补偿逻辑。
      // - `squash`：保留旧的 squash 投影（`main` 是每推一次一个新提交）。
      //   ⚠️ 这个形态会让**合并基底退化为旧祖先**，云端 merge 必然大量冲突
      //   （2026-10-19 云端 dry-run 实测 10 个文件）—— 仅作兼容保留。
      const mode = process.env.OFM_MAIN_SYNC_MODE ?? 'history'
      if (mode === 'history') {
        say(`投影 HEAD → origin/${releaseBranch}（force-with-lease，保持常规历史）…`)
        const projected = run('git', ['push', '--force-with-lease', 'origin', `HEAD:${releaseBranch}`])
        say(projected.output.trim().slice(-1500))
        if (projected.code !== 0) throw new Error(`投影 ${releaseBranch} 失败`)
        say(`  ✅ ${releaseBranch} 已与 ${workBranch} 同历史`)
      } else {
        say(`投影 HEAD → origin/${releaseBranch}（squash，单提交）…`)
        const tokenForPush = process.env.GH_TOKEN
          ?? (fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : '')
        const projected = run('node', ['scripts/api-push-squash.mjs'], {
          GH_TOKEN: tokenForPush,
          OFM_PUSH_BRANCH: releaseBranch,
        })
        say(projected.output.trim().slice(-1500))
        if (projected.code !== 0) throw new Error(`投影 ${releaseBranch} 失败`)
      }
    } else {
      const token = process.env.GH_TOKEN ?? (fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : '')
      if (token === '') throw new Error('无 GH_TOKEN（环境变量或 .private/gh-token）')
      const pushed = run('node', ['scripts/api-push-squash.mjs'], { GH_TOKEN: token })
      say(pushed.output.trim())
      if (pushed.code !== 0) throw new Error('推送失败')
    }

    writeState({ lastUpstreamSha: upstreamHead })
    say(`✅ 同步完成：上游 ${upstreamHead.slice(0, 7)} → 本地 ${git('rev-parse', 'HEAD').trim().slice(0, 7)}`)
  } catch (error) {
    // 测试/构建/签名任一失败：回滚到合并前。远端未动，无副作用。
    const conflicted = run('git', ['diff', '--name-only', '--diff-filter=U']).output
      .split('\n').map(line => line.trim()).filter(Boolean)
    const currentHead = git('rev-parse', 'HEAD').trim()
    run('git', ['reset', '--hard', preMergeHead])
    say(`已回滚到 ${preMergeHead.slice(0, 7)}（远端未受影响）`)
    failOut(
      classifyFailure(error.message),
      error instanceof Error ? error.message : String(error),
      { upstreamHead, preMergeHead, headAtFailure: currentHead, conflictedFiles: conflicted },
    )
  }
}

await main()
