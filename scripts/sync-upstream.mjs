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

/** ⚠️ 不要在这里手写「发布内容」清单：revision 判据必须与 catalog-test /
 * prepare-release 用同一算法（`package.json` + 其 `files` 列表）。
 * 手写清单会与 `package.json.files` 漂移，release 模式的 catalog-test 立刻变红。 */

/** 冲突时可以安全「取 ours」的生成产物（随后重建/重签，内容总是正确的）。 */
const GENERATED = new Set([
  'feed/manifest.json',
  'catalog/integrity.json',
  'catalog/dsh-plugin.json',
  'catalog/provenance.json',
  'vendor/channel-pack/pack.js',
])

/** 合并后必须通过的目标测试集（全量 test-all 中已知稳定通过的部分；
 * reload 套件在上游纯净分支同样失败，属上游与 Node 24 的兼容问题，不列入）。 */
const TESTS = [
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

/** 把失败消息归到「哪一步」——通知里要能一眼看出是冲突还是测试挂。 */
function classifyFailure(message) {
  if (/需要人工判断的冲突|CONFLICT|Merge conflict/i.test(message)) return 'merge-conflict'
  if (/测试失败|[Tt]est failed/i.test(message)) return 'test-failed'
  if (/签名|sign/i.test(message)) return 'sign-failed'
  if (/重建|build/i.test(message)) return 'build-failed'
  if (/推送|push/i.test(message)) return 'push-failed'
  return 'unknown'
}

function main() {
  say(`sync-upstream 开始${dryRun ? '（--dry-run）' : ''}`)

  // ── 1. 拉上游（镜像免认证） ─────────────────────────────────────────────
  say('fetch upstream …')
  const fetched = run('git', ['fetch', '--force', 'upstream', 'main:refs/remotes/upstream/main'])
  if (fetched.code !== 0) { say(`❌ fetch 失败：${fetched.output.slice(0, 300)}`); process.exit(1) }
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
    say(`❌ 工作区不干净，放弃本次同步（不覆盖未提交改动）：\n${dirty}`)
    process.exit(1)
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
    const unresolvable = conflicted.filter(file => !GENERATED.has(file))
    if (conflicted.length === 0 || unresolvable.length > 0) {
      run('git', ['merge', '--abort'])
      say(`❌ 存在需要人工判断的冲突，已回滚合并，留待处理：\n${unresolvable.join('\n')}`)
      process.exit(1)
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
      say(`❌ 冲突解决后提交失败：${resolved.output.slice(0, 200)}`)
      process.exit(1)
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
      const branch = process.env.OFM_PUSH_BRANCH ?? 'main'
      say(`推送 HEAD → origin/${branch}（--ci，常规 git push）…`)
      const pushed = run('git', ['push', 'origin', `HEAD:${branch}`])
      say(pushed.output.trim().slice(-1500))
      if (pushed.code !== 0) throw new Error('推送失败')
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
    say(`❌ ${error.message}`)
    // 冲突文件清单（若非冲突类失败则为空；workflow 用它做通知摘要）。
    const conflicted = run('git', ['diff', '--name-only', '--diff-filter=U']).output
      .split('\n').map(line => line.trim()).filter(Boolean)
    const currentHead = git('rev-parse', 'HEAD').trim()
    run('git', ['reset', '--hard', preMergeHead])
    say(`已回滚到 ${preMergeHead.slice(0, 7)}（远端未受影响）`)
    /**
     * `--fail-file <path>`：把结构化失败信息写出来。
     *
     * 为什么由**脚本**写而不是 workflow 自己拼：失败步骤与冲突文件只有脚本
     * 知道（workflow 只看得到 exit code）。写成一个文件后，workflow 只需把它
     * 提交到 fork，本机通知桥再读。
     */
    const failFile = flag('fail-file')
    if (failFile !== undefined) {
      const payload = {
        failedAt: new Date().toISOString(),
        failedStep: classifyFailure(error.message),
        message: error.message,
        upstreamHead,
        preMergeHead,
        headAtFailure: currentHead,
        conflictedFiles: conflicted,
        runUrl: process.env.GITHUB_RUN_URL ?? '',
      }
      fs.writeFileSync(failFile, JSON.stringify(payload, null, 2) + '\n')
      say(`失败信息已写入 ${failFile}`)
    }
    process.exit(1)
  }
}

main()
