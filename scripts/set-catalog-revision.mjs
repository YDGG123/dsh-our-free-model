/**
 * 把 catalog 的 revision 字段直接设为给定提交（而不是「本地最后一次触碰发布内容的提交」）。
 *
 *     node scripts/set-catalog-revision.mjs <40 位 sha>
 *
 * ## 为什么需要它（而不总是用 refresh-revision.mjs）
 *
 * `refresh-revision.mjs` 回答的是「**本地**最后一次触碰发布内容的提交是谁」。
 * 这在**本地**推送语义下是对的（推送后的远端 commit 与本地一致，除 squash 外）。
 *
 * 但云端 `--ci` 推完 `main` 之后情况不同：远端多出的是**新** commit，本地那份
 * sha 在远端**根本不存在**（实测 `GET /git/commits/<local-sha>` 返回 404）。
 * 此时唯一正确的值就是**远端 HEAD** —— 内容确实在它里面，与 `catalog-test`
 * 的判据（「最后一次触碰发布内容的提交」）等价。
 *
 * ## 为什么单独成文件
 *
 * 第一版把这段写成 `node -e '…'` 内联在同步脚本里（三层引号 + 模板字符串），
 * 既不可读也不可测。抽出来后可以本地直接验证、也能被单测覆盖。
 *
 * @module scripts/set-catalog-revision.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

/** catalog 里两处记录 revision 的位置（与 `refresh-revision.mjs` 同口径）。 */
export const REVISION_TARGETS = [
  { file: 'catalog/dsh-plugin.json', key: 'revision', pick: doc => doc.source },
  { file: 'catalog/provenance.json', key: 'sourceRevision', pick: doc => doc.subject },
]

const SHA = /^[0-9a-f]{40}$/

/**
 * 把两个文件里的 revision 写成 `revision`。
 *
 * @param {string} revision 40 位 sha
 * @param {{ root?: string, write?: (file: string, text: string) => void }} [options]
 * @returns {{ changed: string[], skipped: string[] }}
 */
export function setCatalogRevision(revision, options = {}) {
  if (!SHA.test(revision)) throw new Error(`revision 必须是 40 位小写 sha，收到: ${revision}`)
  const base = options.root ?? root
  const write = options.write ?? ((file, text) => fs.writeFileSync(file, text))
  const changed = []
  const skipped = []
  for (const target of REVISION_TARGETS) {
    const file = path.join(base, target.file)
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const holder = target.pick(doc)
    // 结构缺失时**报错而不是静默跳过**：写不进去意味着之后的校验必然红，
    // 早失败比让它跑到测试阶段再炸清楚得多。
    if (typeof holder !== 'object' || holder === null) {
      throw new Error(`${target.file} 缺少 source/subject 结构，无法写入 revision`)
    }
    if (holder[target.key] === revision) { skipped.push(target.file); continue }
    holder[target.key] = revision
    write(file, `${JSON.stringify(doc, null, 2)}\n`)
    changed.push(target.file)
  }
  return { changed, skipped }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    const revision = process.argv[2]
    if (revision === undefined) throw new Error('用法: node scripts/set-catalog-revision.mjs <40 位 sha>')
    const result = setCatalogRevision(revision)
    if (result.changed.length === 0) console.log(`catalog revision already points at ${revision.slice(0, 7)}`)
    for (const file of result.changed) console.log(`${file}: revision -> ${revision.slice(0, 7)}`)
  } catch (error) {
    console.error(`set-catalog-revision: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
