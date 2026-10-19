# 测试脚本「静默空过」假绿灯修复

日期：2026-10-19　范围：`scripts/`（仅测试脚本，未改插件源码）

## 背景

Tester 在复核任务三时发现：`node scripts/channel-credits-ui-test.mjs` **永远返回 0**，
即使把实现改回旧逻辑（变异测试）也一样。追查后确认这是一类**测试基建缺陷**：

> `scripts/` 下有一批脚本**只 `export` 一个验证函数、没有自执行入口**。
> 直接 `node <file>` 时它们只做模块初始化就退出，**什么都不验证**，退出码恒为 0。

危害不是「少跑一个用例」，而是**假绿灯**：CI 或人工按文件名逐个跑时会得到一次
「通过」，而那次什么都没做。任务三的变异测试就差点被它骗过 —— 改坏了代码，
`node scripts/channel-credits-ui-test.mjs` 依然 EXIT=0。

## 怎么发现的

Tester 做变异测试时的现象：把 `client.js` 的已领判定改回旧写法
（`todayCheckedIn && Number.isFinite(todayCredit)` 并列），预期用例应该失败，
但 `node scripts/channel-credits-ui-test.mjs` 仍是 EXIT=0。改用
`node scripts/channel-pack-test.mjs`（真正 import 并调用该函数的地方）后
立刻报 `AssertionError: 已领但缺 todayCredit 时仍必须显示已领`。

## 排查结果

对 `scripts/*-test.mjs` 全量扫描（直接执行，输出为空且退出码 0 者判为静默）：

| 脚本 | 是否静默空过 | 真实执行者 |
|---|---|---|
| `channel-credits-ui-test.mjs` | **是** | `channel-pack-test.mjs` |
| `channel-credits-rpc-test.mjs` | **是** | `channel-pack-test.mjs` |
| `channel-model-actions-test.mjs` | **是** | `channel-pack-test.mjs` |
| `channel-image-pricing-test.mjs` | **是** | `channel-pack-test.mjs` |
| `standalone-channel-filter-test.mjs` | **是** | `standalone-frontend-test.mjs` |
| `standalone-model-operation-test.mjs` | **是** | `standalone-frontend-test.mjs` |
| `standalone-login-terminal-test.mjs` | **是** | `standalone-management-test.mjs` |
| `channel-pr-fixes-test.mjs` | **是** | `channel-pack-test.mjs --source` |

`channel-pack-test.mjs` 自身**不是**静默的（它有顶层 `await`），之前被误列为嫌疑，
是因为它的 `export function createUserMessage` 只存在于一段模板字符串文本里
（`llmKernel` 这个 data URL），并不是真实导出。

## 修法（两种，按「能不能独立跑」分开）

### 1. 能独立跑的直接执行并给出真实退出码

`channel-credits-ui-test.mjs` / `channel-model-actions-test.mjs` /
`standalone-channel-filter-test.mjs` / `standalone-model-operation-test.mjs` /
`standalone-login-terminal-test.mjs`：

```js
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (invokedDirectly) {
  try {
    await verifyXxx()
    console.log('xxx: all ok')
    process.exitCode = 0
  } catch (error) {
    console.error(`xxx: FAILED — ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
```

被 `import` 时行为**完全不变**（不自动跑，时机仍由调用方掌握）。

### 2. 离不开宿主上下文的：**如实报错并给非零退出码**

`channel-credits-rpc-test.mjs`（需要挂载好的 `ctx / call / creds`）、
`channel-image-pricing-test.mjs`（需要挂载出的 `adapters` 表）、
`channel-pr-fixes-test.mjs`（依赖 `channel-pack-test` 安装的 `.js→.ts` 解析钩子）：

```js
if (invokedDirectly) {
  console.error('…需要宿主上下文，请运行 `node scripts/channel-pack-test.mjs`')
  process.exitCode = 2
}
```

**为什么不给它们也造一套宿主**：那等于在 `channel-pack-test` 之外复制一份挂载逻辑，
两份必然漂移 —— 本仓库已经有过「两份名单漂移」的真实缺陷。宁可让直接执行**失败**，
也不让它**假装通过**。

`channel-pr-fixes-test.mjs` 这一条尤其值得记：最初我也给它加了「直接跑」的入口，
结果它抛 `Cannot find module …/message-shape.js` —— 那条报错**看起来像真缺陷**
（像是源码坏了），实际只是缺 `.js→.ts` 解析钩子。故改成显式说明。

### 3. `test-all.mjs` 套件表同步修正

原先表里有四行（`channel-credits-rpc` / `channel-model-actions` /
`channel-image-pricing`，以及本就正常跑的 `channel-credits-ui`）指向这些脚本。
其中前三者**永远无法独立执行**，留在表里只会产出「静默绿灯」。已移除并加注说明：

- 真正的覆盖由 `channel-pack`（`channel-pack-test.mjs`）负责；
- 套件表条目从 76 变为 73（contributor 模式 74 → 71），这是**计数变准**，不是覆盖变少。

`channel-credits-ui` 保留在表里 —— 它现在有自执行入口，能真实独立跑。

## 验证

### 直接执行（每个改过的脚本）

| 脚本 | 直接执行结果 |
|---|---|
| `channel-credits-ui-test.mjs` | `channel-credits-ui: all ok`，exit 0 |
| `channel-model-actions-test.mjs` | `channel-model-actions: all ok`，exit 0 |
| `standalone-channel-filter-test.mjs` | `standalone-channel-filter: all ok`，exit 0 |
| `standalone-model-operation-test.mjs` | `standalone-model-operation: all ok`，exit 0 |
| `standalone-login-terminal-test.mjs` | `standalone-login-terminal: all ok`，exit 0 |
| `channel-credits-rpc-test.mjs` | 明确提示需宿主上下文，exit 2 |
| `channel-image-pricing-test.mjs` | 明确提示需适配器表，exit 2 |
| `channel-pr-fixes-test.mjs` | 明确提示需解析钩子，exit 2 |

### 变异测试（证明新入口真的能抓到失败）

逐个故意破坏被验证的逻辑，确认**直接执行**时退出码变为 1，还原后回到 0：

| 脚本 | 变异后 | 还原后 |
|---|---|---|
| `channel-credits-ui-test.mjs` | exit **1**（`FAILED — mutation probe`） | exit 0 |
| `standalone-channel-filter-test.mjs` | exit **1** | exit 0 |
| `standalone-model-operation-test.mjs` | exit **1** | exit 0 |
| `standalone-login-terminal-test.mjs` | exit **1** | exit 0 |

⚠️ 注意测量方式：`node x.mjs | grep …` 的 `$?` 是 **grep** 的退出码，不是 node 的。
我第一次就量错了（看到 exit=0 差点以为变异没生效），必须重定向到文件后再取 `$?`。

### 全量扫描（修完之后）

对 `scripts/*-test.mjs` 全量直接执行并检查「输出为空」：**零命中**
（修之前命中 8 个）。

### 回归

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test:contributor` | **71/72**，唯一失败是已知基线 `reload-test` |
| `node scripts/channel-pack-test.mjs` | 通过（仍覆盖 credits UI + RPC + model-actions + image-pricing） |
| `node scripts/channel-pack-test.mjs --source --channels-only` | 通过（仍覆盖 PR fixes） |
| `node scripts/client-lint.mjs` | OK（706 键 / 176 规则） |
| `pack.js` | **未变**，sha256 `58731f2b…`（本次只动测试脚本） |

## 边界

- 未改任何插件源码（`vendor/channel-pack/src/**`、`client.js`、`index.js`），
  故 `pack.js` 哈希与任务三交付时一致。
- 未 push、未改版本号。
- 覆盖范围没有减少：那三个「不能独立执行」的脚本，其验证仍由
  `channel-pack-test.mjs` 100% 触发（套件数从 74 降到 71 是**去掉重复的假绿灯**，
  不是去掉用例）。

## 给后续的提醒

新增 `scripts/*-test.mjs` 时二选一：

1. 能独立跑 ⇒ 加 `invokedDirectly` 自执行入口，并保证失败时 `process.exitCode = 1`；
2. 依赖宿主上下文 ⇒ 加 `invokedDirectly` 分支，明确报错 + `process.exitCode = 2`，
   **并不要**把它单独列进 `test-all.mjs` 的套件表（列了就是假绿灯）。
