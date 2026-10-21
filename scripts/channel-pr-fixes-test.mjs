/** Offline source regressions, run by channel-pack-test.mjs --source. */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { pathToFileURL } from 'node:url'

const collect = async iterable => {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
const textMessage = (role, text) => ({ role, content: [{ type: 'text', text }] })
const sse = frame => new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
const answer = text => sse({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })

async function within(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1000) }),
    ])
  } finally { clearTimeout(timer) }
}

export async function verifyChannelPrFixes() {
  await verifySystemPrompts()
  await verifyGatewayTeardown()
}

async function verifySystemPrompts() {
  const { translateGeminiRequest } = await import('../vendor/channel-pack/src/gemini-messages.ts')
  const { buildMinimaxMessagesPayload } = await import('../vendor/channel-pack/src/minimax-messages.ts')
  const { collectHarnessSystem } = await import('../vendor/channel-pack/src/message-shape.ts')
  assert.equal(collectHarnessSystem([
    null, { role: 'system' }, { role: 'system', content: 'bare' },
    { role: 'system', content: [{ type: 'image' }, { type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
    textMessage('developer', 'metadata'),
  ]), 'bare\n\none\ntwo')
  const user = textMessage('user', 'hello')
  for (const [name, messages, system, expected] of [
    ['message only', [textMessage('system', 'sentinel'), user], undefined, 'sentinel'],
    ['field only', [user], 'sentinel', 'sentinel'],
    ['identical carriers', [textMessage('system', 'sentinel'), user], 'sentinel', 'sentinel'],
    ['distinct carriers', [textMessage('system', 'history'), user], 'field', 'field\n\nhistory'],
    ['multiple systems', [textMessage('system', 'one'), textMessage('system', 'two'), user], undefined, 'one\n\ntwo'],
    ['identical aggregate', [textMessage('system', 'one'), textMessage('system', 'two'), user], 'one\n\ntwo', 'one\n\ntwo'],
    ['empty carriers', [textMessage('system', ''), user], '', undefined],
    ['absent carriers', [user], undefined, undefined],
  ]) {
    const before = structuredClone(messages)
    const gemini = translateGeminiRequest({
      modelId: 'fixture', spec: { upstream: 'fixture', includeThoughts: false, thinkingBudget: -1 },
      messages, system, requestId: 'fixture-request',
    }).request
    const minimax = buildMinimaxMessagesPayload({ model: 'fixture', messages, system })
    assert.equal(gemini.systemInstruction?.parts.map(part => part.text).join('\n'), expected, `Gemini ${name}`)
    assert.equal(minimax.system, expected, `MiniMax ${name}`)
    assert.deepEqual(gemini.contents, [{ role: 'user', parts: [{ text: 'hello' }] }], `Gemini ${name}: conversation`)
    assert.deepEqual(minimax.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], `MiniMax ${name}: conversation`)
    assert.deepEqual(messages, before, `${name}: input is preserved`)
    if (expected === undefined) {
      assert.equal('systemInstruction' in gemini, false)
      assert.equal('system' in minimax, false)
    }
  }
  console.log('ok  source PR #401: message/field/multiple/empty system prompts, identical-carrier deduplication, unchanged conversation')
}

async function verifyGatewayTeardown() {
  const { createOpenAiGateway } = await import('../vendor/channel-pack/src/openai-gateway/server.ts')
  for (const kind of ['idle', 'active-model-list', 'incomplete-headers', 'active-stream']) {
    const reserve = net.createServer()
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
    const port = reserve.address().port
    await new Promise(resolve => reserve.close(resolve))
    let entered, ended, streamSignal
    const started = new Promise(resolve => { entered = resolve })
    const streamEnded = new Promise(resolve => { ended = resolve })
    const gateway = createOpenAiGateway({
      env: { DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'fixture-local-key' },
      logger: { info() {}, warn() {}, error() {} },
      llm: {
        listProviders: () => [{ id: 'fixture' }],
        listModels: async () => { entered(); return kind === 'active-model-list' ? new Promise(() => {}) : [] },
        resolveModelInfo: async () => ({}),
        async *stream(options) {
          streamSignal = options.signal
          try {
            yield { type: 'text-delta', index: 0, text: 'fixture-stream' }
            await new Promise(resolve => {
              if (streamSignal.aborted) resolve()
              else streamSignal.addEventListener('abort', resolve, { once: true })
              entered()
            })
          } finally { ended() }
        },
      },
    })
    let request, socket, closing
    const agent = new http.Agent({ keepAlive: true })
    try {
      await gateway.start()
      if (kind === 'incomplete-headers') {
        socket = net.connect(port, '127.0.0.1')
        socket.on('error', () => {})
        await within(new Promise(resolve => socket.once('connect', resolve)), `${kind}: connect`)
        socket.write('GET /v1/models HTTP/1.1\r\nHost: localhost\r\n')
        await new Promise(resolve => setTimeout(resolve, 20))
      } else {
        const complete = new Promise((resolve, reject) => {
          request = http.request({
            host: '127.0.0.1', port, agent,
            path: kind === 'active-stream' ? '/v1/chat/completions' : '/v1/models',
            method: kind === 'active-stream' ? 'POST' : 'GET',
            headers: { authorization: 'Bearer fixture-local-key', 'content-type': 'application/json' },
          }, response => {
            response.on('error', () => {})
            response.resume()
            response.once('end', resolve)
          })
          request.on('error', reject)
          request.end(kind === 'active-stream' ? JSON.stringify({
            model: 'fixture/model', messages: [{ role: 'user', content: 'hello' }], stream: true,
          }) : undefined)
        })
        void complete.catch(() => {})
        await within(kind === 'idle' ? complete : started, `${kind}: request`)
      }
      closing = gateway.close()
      await within(closing, `${kind}: close`)
      if (kind === 'active-stream') {
        assert.equal(streamSignal.aborted, true, 'gateway shutdown aborts upstream inference')
        await within(streamEnded, 'stream cancellation')
      }
      await gateway.close()
    } finally {
      request?.destroy()
      socket?.destroy()
      agent.destroy()
      await within(closing ?? gateway.close(), `${kind}: cleanup`)
    }
  }
  console.log('ok  source PR #405: idle/active/incomplete HTTP connections close within 1s, upstream stream aborted, repeated close safe')
}

/**
 * 自执行入口（2026-10-19）：只导出的脚本直接 `node` 跑会静默空过（假绿灯）。
 *
 * ⚠️ 但本套件**无法**独立执行：它跑的是 `vendor/channel-pack/src/*.ts`，而那些
 * TS 之间用 `./x.js` 互相引用 —— 需要 `channel-pack-test.mjs` 里
 * `registerHooks` 安装的 `.js → .ts` 解析钩子才能加载。没有钩子会抛
 * `Cannot find module …/message-shape.js`，那条报错**看起来像真缺陷**，
 * 实际只是缺运行环境（我第一次加入口时就撞上了）。
 *
 * 故直接执行时如实说明并给非零退出码，不假装跑过。
 */
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (invokedDirectly) {
  console.error(
    'channel-pr-fixes: 本套件依赖 channel-pack-test 安装的 .js→.ts 解析钩子，无法独立执行。\n'
    + '请运行 `node scripts/channel-pack-test.mjs --source --channels-only`。',
  )
  process.exitCode = 2
}
