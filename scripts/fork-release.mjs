/**
 * 发布本 fork 的一个可安装版本（纯本机，不依赖 GitHub Actions）。
 *
 * ## 它做什么
 *
 * 1. 用 `.private/ofm-release-key.pem` 重签 `feed/manifest.json` 与 `catalog/*`
 * 2. **独立复核**：用仓库里钉死的公钥验证刚生成的签名
 * 3. 提交签名结果并推送到 fork 的 `main`
 *
 * 推送之后，插件在别的机器上（或本机重装时）就能通过「检查更新」拿到这一版。
 * 为什么必须签名：插件只信任 `src/updater.js` 里 `PINNED_MANIFEST_PUBLIC_KEY`
 * 那一把公钥；没有签名或签名不符的清单会被 `verifyManifestSignature` 拒绝。
 *
 * ## 用法
 *
 *     node scripts/fork-release.mjs                 # 签名 + 提交 + 推送
 *     node scripts/fork-release.mjs --no-push       # 只签名并提交到本地
 *     node scripts/fork-release.mjs --check-only    # 只核对清单与磁盘是否一致
 *
 * 私钥路径可用 `OFM_RELEASE_KEY` 覆盖（默认 `.private/ofm-release-key.pem`）。
 *
 * ## 与上游脚本的分工
 *
 * `scripts/prepare-release.mjs` 是上游为「多贡献者 + 受保护环境 + 双人审查」
 * 设计的，它把签名产物交给 CI 去应用。本 fork 由单人维护，直接在本机签名
 * 并推送即可；安全性质不变——私钥仍然只在你手上，且不会进仓库。
 *
 * @module scripts/fork-release.mjs
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  PINNED_MANIFEST_PUBLIC_KEY,
  parseManifest,
  verifyManifestSignature,
} from '../src/updater.js'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const args = new Set(process.argv.slice(2))
const keyPath = process.env.OFM_RELEASE_KEY ?? path.join(root, '.private', 'ofm-release-key.pem')
const manifestPath = path.join(root, 'feed', 'manifest.json')

const say = message => console.log(`fork-release: ${message}`)
const fail = message => {
  console.error(`fork-release: ${message}`)
  process.exit(1)
}

/** Run a command in the repo root and return its trimmed stdout. */
const git = (...argv) => execFileSync('git', argv, { cwd: root, maxBuffer: 16 * 1024 * 1024 }).toString().trim()

/** Refuse to publish from anything but a clean, pushed working tree. */
function assertCleanTree() {
  const dirty = git('status', '--porcelain')
  if (dirty !== '') {
    fail(`工作区不干净，先提交或还原：\n${dirty.split('\n').map(line => `  ${line}`).join('\n')}`)
  }
}

function assertKey() {
  if (!fs.existsSync(keyPath)) {
    fail(
      `找不到私钥 ${path.relative(root, keyPath)}。\n`
      + '  它应该只存在于本机与 GitHub secret 中（见 docs/FORK.md）。\n'
      + '  用 OFM_RELEASE_KEY 指向别处，或从备份恢复。',
    )
  }
  // A world-readable private key is a leak waiting to happen.
  const mode = fs.statSync(keyPath).mode & 0o777
  if ((mode & 0o077) !== 0) {
    fail(`私钥权限过于宽松（${mode.toString(8)}），执行：chmod 600 ${path.relative(root, keyPath)}`)
  }
}

/** Verify the freshly written manifest against the pinned key. */
function verifySigned() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (typeof manifest.signature !== 'string' || manifest.signature === '') {
    fail('feed/manifest.json 没有签名 —— 升级路径会拒绝它')
  }
  if (!verifyManifestSignature(parseManifest(manifest), PINNED_MANIFEST_PUBLIC_KEY)) {
    fail('签名无法用钉死的公钥验证 —— 私钥与公钥不配对，或文件在签名后被改动')
  }
  const bytes = manifest.files.reduce((sum, file) => sum + file.size, 0)
  say(`✅ 签名验证通过：${manifest.version}，${manifest.files.length} 个文件，${bytes} 字节`)
  return manifest
}

function main() {
  // `--check-only` never writes: it is the pre-commit gate.
  if (args.has('--check-only')) {
    execFileSync(process.execPath, ['scripts/build-manifest.mjs', '--check'], { cwd: root, stdio: 'inherit' })
    verifySigned()
    return
  }

  assertCleanTree()
  assertKey()

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  say(`准备发布 ${pkg.version}`)

  // 1. 重签。build-manifest 自己会拒绝与钉死公钥不配对的私钥。
  execFileSync(process.execPath, ['scripts/build-manifest.mjs', '--key', keyPath], { cwd: root, stdio: 'inherit' })

  // 2. 复核 —— 不信任上一步"没报错"，独立再验一次签名。
  const manifest = verifySigned()

  // 3. 提交。只有清单类文件会变；代码改动应当已经在之前的提交里。
  const changed = git('status', '--porcelain', '--', 'feed', 'catalog')
  if (changed === '') {
    say('清单与磁盘已一致，无需提交')
    return
  }
  const revision = git('rev-parse', '--short', 'HEAD')
  git('add', 'feed/manifest.json', 'catalog/integrity.json', 'catalog/dsh-plugin.json', 'catalog/provenance.json')
  git('commit', '-m', `catalog: sign the ${manifest.version} release over ${revision}`)
  say(`已提交：${git('rev-parse', '--short', 'HEAD')}`)

  // 4. 推送（除非 --no-push）。
  if (args.has('--no-push')) {
    say('--no-push：停在本地提交。核对无误后执行 git push fork HEAD:main')
    return
  }
  const remotes = git('remote').split('\n')
  if (!remotes.includes('fork')) {
    fail('没有名为 fork 的 remote。先执行：\n  git remote add fork git@github.com:YDGG123/dsh-our-free-model.git')
  }
  git('push', 'fork', 'HEAD:main')
  say('✅ 已推送到 fork/main —— 现在可以在插件面板里检查更新')
}

main()
