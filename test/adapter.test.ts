import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LlmError, ReasoningEffortId, ToolCallId, attributionHeaders, createAssistantMessage,
  createSystemMessage, createToolResultMessage, createUserMessage, createDeveloperMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { MagpieAdapter } from '../src/adapter.ts'
import { chatChunks, chatRequest, chatUsage, sseData } from '../src/protocol.ts'
import type { CallTarget, CatalogGroup, CatalogModel } from '../src/contracts.ts'

const model: CatalogModel = { id: 'workbuddy/claude-test', name: 'Test', contextWindow: 10000, maxTokens: 1000,
  efforts: ['low', 'high'], defaultEffort: 'low', inputModalities: ['text', 'image'] }
const group: CatalogGroup = { route: 'magpie-workbuddy', upstream: 'workbuddy', name: 'Magpie · WorkBuddy', models: [model] }
function setup(fetcher: typeof fetch, resolveAttachments?: () => AttachmentStore | undefined) {
  let target: CallTarget = { gatewayUrl: 'http://magpie.test', gatewayKey: 'SECRET', provider: group.route, model: structuredClone(model) }
  const service = { catalog: () => [group, { ...group, route: 'magpie-codex', name: 'Codex' }], capture: (provider: string, id: string) => {
    if (provider !== group.route || id !== model.id) throw new LlmError('Missing model', 'NO_ADAPTER')
    return target
  } }
  return { adapter: new MagpieAdapter(service, { fetch: fetcher, ...(resolveAttachments ? { resolveAttachments } : {}) }),
    target: () => target, replace: () => { target = { ...target, gatewayUrl: 'http://new.test', gatewayKey: 'NEW', model: { ...target.model, name: 'New' } } } }
}
const options = (): GenerateOptions => ({ provider: group.route, model: model.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
const event = (delta: unknown, finish?: string) => JSON.stringify({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })
const response = (...events: string[]) => new Response(events.map(value => `data: ${value}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
const ok = () => response(event({ content: 'Hi' }), event({}, 'stop'), '[DONE]')
async function collect(stream: AsyncIterable<StreamChunk>) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const mocked = (fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch

test('one adapter lists every group and exposes branded reasoning, context and output defaults', async () => {
  const { adapter } = setup(mocked(async () => ok()))
  assert.equal(adapter.providerInfo(group.route).name, group.name)
  assert.equal((await adapter.listModels('magpie-codex'))[0]?.provider, 'magpie-codex')
  assert.deepEqual(await adapter.listModels('missing'), [])
  const info = await adapter.resolveModel(group.route, model.id)
  assert.equal(info.context?.contextWindow, 10000)
  assert.equal(info.defaultMaxTokens, 1000)
  assert.equal(info.reasoning?.efforts[1]?.id, ReasoningEffortId('high'))
  assert.equal(info.reasoning?.defaultEffort, ReasoningEffortId('low'))
  assert.notEqual(info.inputModalities, group.models[0]?.inputModalities) // detached snapshots
})

test('prepared calls freeze endpoint, key and metadata; full model ids and attribution, never account pin', async () => {
  const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
  const s = setup(mocked(async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }); return ok()
  }))
  const prepared = await s.adapter.prepareCall(group.route, model.id)
  s.target().model.name = 'Mutated'
  s.replace()
  await collect(prepared.stream(options()))
  assert.equal(prepared.model.name, 'Test')
  assert.equal(sent[0]?.url, 'http://magpie.test/v1/chat/completions')
  assert.equal(sent[0]?.headers.get('authorization'), 'Bearer SECRET')
  assert.equal(sent[0]?.headers.get('x-magpie-account'), null)
  for (const [name, value] of Object.entries(attributionHeaders())) assert.equal(sent[0]?.headers.get(name), value)
  assert.equal(sent[0]?.body.model, model.id)
  assert.equal(sent[0]?.body.reasoning_effort, 'low')
  await collect(s.adapter.stream(options()))
  assert.equal(sent[1]?.url, 'http://new.test/v1/chat/completions')
  await assert.rejects(() => collect(prepared.stream({ ...options(), model: 'other' })), { code: 'INVALID_PREPARED_CALL' })
})

test('serializes system, developer, tools, raw arguments, tool errors and reasoning without losing history', async () => {
  const call = ToolCallId('call-1')
  const input: GenerateOptions = { ...options(), system: 'one shot', reasoningEffort: ReasoningEffortId('high'), temperature: 0, maxTokens: 23, stop: ['END'],
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    messages: [createSystemMessage('system'), createDeveloperMessage({ content: [{ type: 'text', text: 'update' }], source: { kind: 'user' } }),
      createAssistantMessage({ source: { provider: group.route, model: model.id }, content: [
        { type: 'reasoning', text: 'thought' }, { type: 'tool-call', id: call, name: 'read', arguments: '{ "file": "a" }' }] }),
      createToolResultMessage({ callId: call, isError: true, content: [{ type: 'text', text: 'ERROR: missing' }] })] }
  const body = await chatRequest(input, model)
  const messages = body.messages as Record<string, unknown>[]
  // Generic Chat declares complete tools; SDK projects incremental developer events out.
  assert.deepEqual(messages.slice(0, 3).map(message => message.role), ['system', 'system', 'assistant'])
  assert.equal(messages[2]?.reasoning_content, 'thought')
  assert.deepEqual(messages[2]?.tool_calls, [{ id: call, type: 'function', function: { name: 'read', arguments: '{ "file": "a" }' } }])
  assert.deepEqual(messages[3], { role: 'tool', tool_call_id: call, content: 'ERROR: missing' })
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object' } } }])
  assert.equal(body.temperature, 0); assert.equal(body.max_tokens, 23); assert.deepEqual(body.stop, ['END'])
  assert.equal(body.reasoning_effort, 'high')
})

const image = { attachmentId: 'image-id', mediaType: 'image/png', bytes: 3, width: 2, height: 2, name: 'plot.png' } as ImageAttachmentRef
function imageStore() {
  let reads = 0
  const store = { readImageRequest: async (ref: ImageAttachmentRef, target: unknown, signal?: AbortSignal) => {
    reads++; assert.deepEqual(ref, image); assert.deepEqual(target, { width: 2, height: 2, maxBytes: 3 }); assert.equal(signal?.aborted, false)
    return { attachment: ref, data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 2, height: 2 }
  }, fileHostPath: () => 'C:/readonly/report.txt' } as unknown as AttachmentStore
  return { store, reads: () => reads }
}
test('durable images resolve request bytes, files use handles, tool images follow tool-result in user content', async () => {
  const { store, reads } = imageStore()
  const input: GenerateOptions = { ...options(), signal: new AbortController().signal, messages: [
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: image },
      { type: 'file', attachment: { attachmentId: 'file' as never, name: 'report.txt', bytes: 123 } }] }),
    createToolResultMessage({ callId: ToolCallId('c'), isError: false, content: [{ type: 'text', text: 'output' }, { type: 'image', attachment: image }] }),
  ] }
  const body = await chatRequest(input, model, store)
  const messages = body.messages as { role: string; content: unknown }[]
  assert.equal(reads(), 2)
  assert.match(JSON.stringify(messages[0]), /data:image\/png;base64,AQID/)
  assert.match(JSON.stringify(messages[0]), /report.txt/)
  assert.match(JSON.stringify(messages[0]), /C:\/readonly\/report.txt/)
  assert.equal(messages[1]?.role, 'tool'); assert.equal(messages[2]?.role, 'user')
})
test('offloaded and text-only images never read attachment bytes; missing service fails explicitly', async () => {
  const { store, reads } = imageStore()
  const input: GenerateOptions = { ...options(), messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: image, offloaded: true }] })] }
  assert.match(JSON.stringify(await chatRequest(input, model, store)), /image-id/)
  input.messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: image }] })]
  await chatRequest(input, { ...model, inputModalities: ['text'] }, store)
  assert.equal(reads(), 0)
  await assert.rejects(() => chatRequest(input, model), { code: 'UNSUPPORTED_CONTENT' })
})

test('SSE handles byte-fragmented UTF8, CRLF, comments, multi-line JSON and trailing event', async () => {
  const bytes = new TextEncoder().encode(':keepalive\r\ndata: {"value":\r\ndata: "你好"}\r\n\r\ndata: [DONE]')
  let i = 0
  const body = new ReadableStream<Uint8Array>({ pull(controller) { if (i < bytes.length) controller.enqueue(bytes.slice(i, ++i)); else controller.close() } })
  const got = []; for await (const value of sseData(body)) got.push(value)
  assert.deepEqual(got, ['{"value":\n"你好"}', '[DONE]'])
})
test('stream translates reasoning/text, interleaved fragmented tool calls and usage to one terminal finish', async () => {
  const { adapter } = setup(mocked(async () => response(
    event({ reasoning_content: 'think' }), event({ content: 'do' }),
    event({ tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{' } }, { index: 0, id: 'a', function: { name: 'one', arguments: '{"x":' } }] }),
    event({ tool_calls: [{ index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '}' } }] }, 'tool_calls'),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 5 } } }), '[DONE]')))
  const chunks = await collect(adapter.stream(options()))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
  const blocks = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
  assert.deepEqual(blocks.slice(0, 2), [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'do' }])
  assert.deepEqual(blocks.slice(2), [{ type: 'tool-call', id: 'b', name: 'two', arguments: '{}' }, { type: 'tool-call', id: 'a', name: 'one', arguments: '{"x":1}' }])
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage'), { type: 'usage', usage: { inputTokens: 70, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 5, totalTokens: 120 } })
})
test('unadvertised reasoning effort fails before request; stale default effort is not sent', async () => {
  await assert.rejects(() => chatRequest({ ...options(), reasoningEffort: ReasoningEffortId('impossible') }, model), { code: 'INVALID_REQUEST' })
  const body = await chatRequest(options(), { ...model, defaultEffort: 'stale' })
  assert.equal(body.reasoning_effort, undefined)
})
test('cache input counters are disjoint; impossible cache/total facts are not advertised', () => {
  assert.deepEqual(chatUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 20, cache_creation_input_tokens: 5 }),
    { inputTokens: 75, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, totalTokens: 110 })
  assert.deepEqual(chatUsage({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 999, prompt_tokens_details: { cached_tokens: 8 } }), { inputTokens: 3, outputTokens: 1 })
  assert.equal(chatUsage({ completion_tokens: 1 }), undefined)
})
test('normalizes length/stop/filter; rejects malformed, truncated, empty and incomplete tool streams', async () => {
  for (const [wire, kind] of [['length', 'max-tokens'], ['stop', 'stop'], ['content_filter', 'error']]) {
    const chunks = await collect(chatChunks((async function* () { yield event({ content: 'a' }, wire) })()))
    const finish = chunks.at(-1)
    assert.equal(finish?.type === 'finish' && finish.reason.kind, kind)
  }
  for (const events of [['bad'], [event({ content: 'partial' })], [event({}, 'stop'), '[DONE]'],
    [event({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, 'tool_calls')], ['[DONE]']]) {
    await assert.rejects(() => collect(chatChunks((async function* () { yield* events })())), LlmError)
  }
})
test('HTTP and in-band errors classify safely and preserve retry-after without secrets', async () => {
  for (const [status, code, message] of [[401, 'AUTH', 'bad'], [429, 'RATE_LIMIT', 'slow'], [400, 'CONTEXT_WINDOW_EXCEEDED', 'maximum context length'], [429, 'QUOTA', 'insufficient_quota'], [503, 'TRANSPORT', 'down']] as const) {
    const { adapter } = setup(mocked(async () => new Response(JSON.stringify({ error: { message: `${message} SECRET http://private.test` } }), { status, headers: { 'retry-after': '2' } })))
    await assert.rejects(() => collect(adapter.stream(options())), (error: unknown) => {
      assert.ok(error instanceof LlmError); assert.equal(error.code, code); assert.equal(error.failure.status, status)
      assert.equal(error.failure.providerRetryAfterMs, 2000); assert.doesNotMatch(error.message, /SECRET|private/); return true
    })
  }
  const { adapter } = setup(mocked(async () => response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'SECRET' } }))))
  await assert.rejects(() => collect(adapter.stream(options())), { code: 'QUOTA' })
})
test('rejects non-SSE success and strips transport error details', async () => {
  for (const fetcher of [mocked(async () => new Response('SECRET')), mocked(async () => { throw new Error('Bearer SECRET') })]) {
    const { adapter } = setup(fetcher)
    await assert.rejects(() => collect(adapter.stream(options())), (error: unknown) => { assert.ok(error instanceof LlmError); assert.doesNotMatch(error.message, /SECRET/); return true })
  }
})
test('pre-abort makes no network call and stalled reader cancellation settles promptly', async () => {
  const abort = new AbortController(); abort.abort()
  let requests = 0
  const first = setup(mocked(async () => { requests++; return ok() }))
  await assert.rejects(() => collect(first.adapter.stream({ ...options(), signal: abort.signal })), { code: 'ABORTED' })
  assert.equal(requests, 0)
  let cancel = false
  let pulled!: () => void
  const started = new Promise<void>(resolve => { pulled = resolve })
  const { adapter } = setup(mocked(async () => new Response(new ReadableStream({ pull() { pulled() }, cancel() { cancel = true } }), { headers: { 'content-type': 'text/event-stream' } })))
  const controller = new AbortController()
  const result = collect(adapter.stream({ ...options(), signal: controller.signal }))
  await started; controller.abort()
  await assert.rejects(() => result, { code: 'ABORTED' }); assert.equal(cancel, true)
})
test('consumer early exit aborts fetch and cancels the response stream', async () => {
  let signal: AbortSignal | undefined, cancelled = false
  const { adapter } = setup(mocked(async (_, init) => {
    signal = init?.signal ?? undefined
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${event({ content: 'a' })}\n\n`)) }, cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
  }))
  for await (const chunk of adapter.stream(options())) if (chunk.type === 'text-delta') break
  assert.equal(cancelled, true); assert.equal(signal?.aborted, true)
})
test('cancels pending fetch or attachment resolution without waiting for a noncooperating backend', async () => {
  let started!: () => void
  let enter = new Promise<void>(resolve => { started = resolve })
  const controller = new AbortController()
  const pendingFetch = setup(mocked(async () => { started(); return new Promise<Response>(() => {}) }))
  const request = collect(pendingFetch.adapter.stream({ ...options(), signal: controller.signal }))
  await enter; controller.abort()
  await assert.rejects(() => request, { code: 'ABORTED' })
  enter = new Promise<void>(resolve => { started = resolve })
  const store = { readImageRequest: async () => { started(); return new Promise(() => {}) } } as unknown as AttachmentStore
  let calls = 0
  const pendingImage = setup(mocked(async () => { calls++; return ok() }), () => store)
  const images = new AbortController()
  const imageRequest = collect(pendingImage.adapter.stream({ ...options(), signal: images.signal, messages: [{ role: 'user', content: [{ type: 'image', attachment: image }] }] }))
  await enter; images.abort()
  await assert.rejects(() => imageRequest, { code: 'ABORTED' }); assert.equal(calls, 0)
})
test('session attribution is transport-only and filtered responses cannot dispatch buffered tools', async () => {
  const { adapter } = setup(mocked(async (_, init) => {
    assert.equal(new Headers(init?.headers).get('x-magpie-session'), 'session-1')
    assert.equal(JSON.parse(String(init?.body)).sessionId, undefined)
    return response(event({ tool_calls: [{ index: 0, id: 'call', function: { name: 'read', arguments: '{}' } }] }, 'content_filter'), '[DONE]')
  }))
  const chunks = await collect(adapter.stream({ ...options(), sessionId: 'session-1' as never }))
  const finish = chunks.at(-1)
  assert.equal(finish?.type === 'finish' && finish.reason.kind, 'error')
})
test('SSE oversized events fail boundedly and cancel their reader', async () => {
  let cancel = false
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(1024 * 1024))) }, cancel() { cancel = true } })
  await assert.rejects(async () => { for await (const _ of sseData(body)) { /* drain */ } }, { code: 'TRANSPORT' })
  assert.equal(cancel, true)
})
