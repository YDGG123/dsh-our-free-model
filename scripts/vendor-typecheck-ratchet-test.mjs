/**
 * vendor 类型检查「棘轮」：vendor/channel-pack 的 TypeScript 错误**不得增加**。
 *
 * ## 为什么要有它（2026-10-22 派单背景）
 *
 * `vendor/channel-pack` 有自己的 tsconfig 但**从没进过 CI**——它的类型错误只会
 * 悄悄累积（esbuild 不查类型，运行也不受影响）。2.5.9 合并时我们用差集法核对过
 * 「合并没引入新错误」，那是手工做的；这个套件把同一件事固化下来。
 *
 * ## ⚠️ 两个坑（Tester 复核 2.5.9 时踩过的，写死在这里）
 *
 * 1. **基线必须是「fork 自己的上一版」，不能拿 upstream/main** —— upstream 没有
 *    我们的定制代码（`index.ts` 的 raccoon/loomy 余额选号段），我们的代码在里面
 *    天然不存在，会被误判成「新增债」。所以基线是**入库的快照文件**，由本仓库
 *    自己维护、随提交走。
 * 2. **对比必须归一化行号** —— 每次改动都会让行号平移，带着 `(行,列)` 比对
 *    会把「同一条错误挪了个位置」误报成「一减一增」。归一化后按
 *    `文件|错误码|消息` 定键；若上游改了联合类型的成员顺序导致**消息文本**
 *    变化，会作为新键出现 ⇒ 棘轮变红 ⇒ 由人确认后 `--update` 基线（这是
 *    有意设计：宁可让 humanos 看一眼，也不要静默吞掉）。
 *
 * ## 基线的更新方式
 *
 *     node scripts/vendor-typecheck-ratchet-test.mjs --update   # 重新生成基线
 *
 * ⚠️ `--update` 只该在**确认新增错误可接受**（或已修掉一部分）时使用——它会把
 * 当前错误集合变成新的基线。减少错误后也鼓励 `--update`（棘轮只升不降会让
 * 修债的人失去激励）。
 *
 * ## 工具链钉死
 *
 * 错误集合对工具链敏感（TS 版本会改变窄化/推断行为）。这里固定用
 * `typescript`（根 devDependency，CI `npm install` 会装）+ `@types/node`
 * （同上，2.5.9 棘轮引入）+ `vendor/channel-pack/tsconfig.json`。基线里记录了
 * 生成时的版本；版本漂移时**警告**但不失败——失败只看「是否出现基线外的新错误」。
 *
 * ## ⚠️ 缺依赖时必须**失败**，不许静默跳过
 *
 * `@types/node` / `typescript` 缺席时这套件跑不了——静默跳过等于没守卫
 * （历史教训：`catch` 里 `return` 掉的降级路径在真机上永远静默）。
 *
 * Run: node scripts/vendor-typecheck-ratchet-test.mjs [--update]
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const BASELINE_FILE = path.join(root, 'scripts', 'lib', 'vendor-typecheck-baseline.json')
const update = process.argv.includes('--update')

const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const typesNodeDir = path.join(root, 'node_modules', '@types', 'node')

if (!fs.existsSync(tscBin)) {
  console.error(`vendor-typecheck-ratchet: typescript 不在 ${tscBin} —— 根 devDependencies 应包含它（CI npm install 会装）`)
  process.exit(1)
}
if (!fs.existsSync(typesNodeDir)) {
  console.error('vendor-typecheck-ratchet: 缺 node_modules/@types/node（根 devDependencies 已包含它，重新 npm install）')
  process.exit(1)
}

/** 归一化一条 tsc 错误行：去掉 `(行,列)`，保留 `文件|TS码|消息`。 */
function normalize(line) {
  const match = /^(.+?)\((\d+),(\d+)\): (error TS\d+: .+)$/.exec(line)
  if (match === null) return null
  const [, file, , , message] = match
  return `${file}|${message.replace(/\s+/g, ' ').trim()}`
}

/**
 * 跑 tsc 并取出诊断行。
 *
 * ⚠️ tsc 在**有类型错误时本来就会以非零码退出**（status 2）——那不是失败，
 * 恰恰是我们要检查的内容。`execFileSync` 会因此抛错，必须接住并从
 * `error.stdout` 里拿诊断（历史教训：把「被检对象失败」当成「检查失败」，
 * 要么误报要么把检查变成空过）。
 */
function runTsc() {
  try {
    return execFileSync(process.execPath, [tscBin, '--noEmit', '-p', path.join(root, 'vendor', 'channel-pack', 'tsconfig.json')], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.includes('error TS')) return error.stdout
    throw error
  }
}

const raw = runTsc()
const current = raw
  .split('\n')
  .map(normalize)
  .filter(entry => entry !== null)
  .sort()

if (current.length === 0 && !update) {
  console.error('vendor-typecheck-ratchet: 一条类型错误都没有 —— 与基线（非空）矛盾。')
  console.error('  多半是 tsc 根本没跑起来或 include 落空，先人工确认，再决定是否 --update。')
  process.exit(1)
}

const toolchain = {
  typescript: JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'typescript', 'package.json'), 'utf8')).version,
  typesNode: JSON.parse(fs.readFileSync(path.join(typesNodeDir, 'package.json'), 'utf8')).version,
}

if (update) {
  const document = { _comment: 'vendor/channel-pack 的类型错误基线。更新方式见 scripts/vendor-typecheck-ratchet-test.mjs 头注；对比时行号已归一化。', toolchain, count: current.length, errors: current }
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(document, null, 2)}\n`)
  console.log(`vendor-typecheck-ratchet: 基线已更新 → ${current.length} 条（ts ${toolchain.typescript} / @types/node ${toolchain.typesNode}）`)
  process.exit(0)
}

if (!fs.existsSync(BASELINE_FILE)) {
  console.error(`vendor-typecheck-ratchet: 基线缺失 ${BASELINE_FILE} —— 先用 --update 生成并入库`)
  process.exit(1)
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
const baselineSet = new Set(baseline.errors)

if (toolchain.typescript !== baseline.toolchain?.typescript || toolchain.typesNode !== baseline.toolchain?.typesNode) {
  console.log(`vendor-typecheck-ratchet: ⚠️ 工具链与基线不同（基线 ts ${baseline.toolchain?.typescript} / @types/node ${baseline.toolchain?.typesNode}；`
    + `当前 ts ${toolchain.typescript} / @types/node ${toolchain.typesNode}）——若因此出现新键，请人工确认后 --update`)
}

const added = current.filter(entry => !baselineSet.has(entry))
const removed = baseline.errors.filter(entry => !current.includes(entry))

let exitCode = 0
if (added.length > 0) {
  exitCode = 1
  console.error(`vendor-typecheck-ratchet: ❌ 出现 ${added.length} 条基线外的类型错误（vendor 类型债不得增加）：`)
  for (const entry of added) console.error(`  + ${entry}`)
  if (removed.length > 0) {
    console.error(`  （同时少了 ${removed.length} 条基线内的 —— 若只是同一处错误换了形态，请人工确认后 --update）`)
  }
  process.exit(exitCode)
}

console.log(`vendor-typecheck-ratchet: ok   ${current.length}/${baseline.count} 条（基线 ${baseline.count}，无新增）`)
if (removed.length > 0) {
  console.log(`  👍 比 ${baseline.count} 少了 ${removed.length} 条 —— 建议跑 --update 把基线降下来，别让后来的修债白做`)
}
if (current.length !== baseline.count) process.exit(0)
process.exit(0)
