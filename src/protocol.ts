/** Provider-neutral DSH messages ↔ OpenAI Chat Completions. No vendor auth/routing logic. */import { Buffer } from 'node:buffer'
import {
  LlmError, ToolCallId, fileHandleText, offloadedImageText, projectToolUpdates,
  requestImageHandleText, textOnlyImageText, isContextWindowExceededError, isQuotaExceededError,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CatalogModel } from './contracts.js'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/**
 * Effective reasoning effort: the session's pick, else 'high', else the first
 * advertised effort. 'default' never reaches dispatch (filtered from catalog)
 * and a model with no efforts sends no field at all.
 */
export function effectiveEffort(options: GenerateOptions, model: CatalogModel): string | undefined {
  if (options.reasoningEffort !== undefined) {
    if (!model.efforts.includes(options.reasoningEffort)) throw new LlmError('This Magpie model does not advertise the selected reasoning effort', 'INVALID_REQUEST')
    return options.reasoningEffort
  }
  if (!model.efforts.length) return undefined
  if (model.efforts.includes('high')) return 'high'
  return model.efforts[0]
}

/** Race even a backend that does not observe AbortSignal; always remove the listener. */
export async function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return pending
  let listener: () => void = () => {}
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      listener = () => reject(signal.reason)
      signal.addEventListener('abort', listener, { once: true })
      if (signal.aborted) listener()
    })])
  } finally { signal.removeEventListener('abort', listener) }
}

/** Serialize all history including raw tool arguments; files are handles, never uploaded. */
export async function chatRequest(options: GenerateOptions, model: CatalogModel, attachments?: AttachmentStore): Promise<ObjectValue> {
  const effort = effectiveEffort(options, model)
  const projected = projectToolUpdates(options.messages, options.tools, undefined, options.toolHistory)
  const messages: ObjectValue[] = []
  if (options.system !== undefined && options.system !== '') messages.push({ role: 'system', content: options.system })
  for (const message of projected.messages) {
    options.signal?.throwIfAborted()
    const parts: ObjectValue[] = []
    const calls: ObjectValue[] = []
    const reasoning: string[] = []
    for (const block of message.content) {
      switch (block.type) {
        case 'text': parts.push({ type: 'text', text: block.text }); break
        case 'reasoning':
          if (message.role === 'assistant') reasoning.push(block.text)
          else parts.push({ type: 'text', text: block.text })
          break
        case 'tool-call':
          if (message.role !== 'assistant') throw new LlmError('Tool calls require an assistant message', 'UNSUPPORTED_CONTENT')
          calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } })
          break
        case 'file': parts.push({ type: 'text', text: fileHandleText(block.attachment, attachments?.fileHostPath(block.attachment)) }); break
        case 'image': {
          const ref = block.attachment
          if (block.offloaded) { parts.push({ type: 'text', text: offloadedImageText(ref) }); break }
          if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
            parts.push({ type: 'text', text: textOnlyImageText(ref) }); break
          }
          if (!attachments) throw new LlmError('Image input requires the DSH attachment service', 'UNSUPPORTED_CONTENT')
          const version = await abortable(attachments.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: ref.bytes }, options.signal), options.signal)
          parts.push({ type: 'text', text: requestImageHandleText(ref, version) })
          parts.push({ type: 'image_url', image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` } })
          break
        }
        case 'tool-addition': case 'tool-removal':
          throw new LlmError('Unprojected tool update in Chat Completions history', 'UNSUPPORTED_CONTENT')
        default: throw new LlmError('Unsupported message content', 'UNSUPPORTED_CONTENT')
      }
    }
    const textOnly = parts.every(part => part.type === 'text')
    // Chat tool-result content is text; images become a subsequent user message.
    const content = textOnly ? parts.map(part => part.text as string).join('\n') : parts
    if (message.role === 'tool') {
      const text = parts.filter(part => part.type === 'text').map(part => part.text as string).join('\n')
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: text })
      if (!textOnly) messages.push({ role: 'user', content: parts.filter(part => part.type !== 'text') })
    } else {
      messages.push({ role: message.role, content: parts.length ? content : null,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(reasoning.length ? { reasoning_content: reasoning.join('') } : {}) })
    }
  }
  return {
    model: model.id, messages, stream: true, stream_options: { include_usage: true },
    ...(projected.tools?.length ? { tools: projected.tools.map(tool => ({ type: 'function', function: {
      name: tool.name, description: tool.description, parameters: tool.parameters,
    } })) } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : model.maxTokens !== undefined ? { max_tokens: model.maxTokens } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }
}

/** Aggregate OpenAI prompt counters include cache; DSH input/cache counters are disjoint. */
export function chatUsage(raw: unknown): TokenUsage | undefined {
  const usage = object(raw)
  const prompt = count(usage.prompt_tokens)
  const output = count(usage.completion_tokens)
  if (prompt === undefined || output === undefined) return undefined
  const details = object(usage.prompt_tokens_details)
  const read = count(details.cached_tokens) ?? count(usage.prompt_cache_hit_tokens) ?? count(usage.cache_read_input_tokens) ?? 0
  const write = count(details.cache_write_tokens) ?? count(usage.cache_creation_input_tokens) ?? 0
  const validCache = read + write <= prompt
  const total = count(usage.total_tokens)
  const reasoning = count(object(usage.completion_tokens_details).reasoning_tokens)
  return { inputTokens: validCache ? prompt - read - write : prompt, outputTokens: output,
    ...(validCache && read ? { cacheReadTokens: read } : {}),
    ...(validCache && write ? { cacheWriteTokens: write } : {}),
    ...((total === undefined || total === prompt + output) ? { totalTokens: prompt + output } : {}),
    ...(reasoning !== undefined && reasoning <= output ? { reasoningTokens: reasoning } : {}),
  }
}

/** Classify raw upstream details, but never expose response bodies or credentials in errors. */
export function chatError(status: number, raw: unknown, retryAfter?: string | null): LlmError {
  const error = object(object(raw).error)
  const detail = [error.code, error.type, error.message].filter(value => typeof value === 'string').join(' ')
  const code = isContextWindowExceededError(detail) ? 'CONTEXT_WINDOW_EXCEEDED'
    : isQuotaExceededError(detail) ? 'QUOTA'
    : status === 401 || status === 403 || /invalid_api_key|authentication_error/.test(detail) ? 'AUTH'
    : status === 429 || /rate_limit_exceeded|rate_limit_error/.test(detail) ? 'RATE_LIMIT'
    : status === 408 || status === 504 ? 'TIMEOUT'
    : status >= 500 ? 'TRANSPORT' : 'INVALID_REQUEST'
  const seconds = retryAfter === null || retryAfter === undefined || retryAfter.trim() === '' ? NaN : Number(retryAfter)
  const deadline = retryAfter ? Date.parse(retryAfter) - Date.now() : NaN
  const delay = Number.isFinite(seconds) ? seconds * 1000 : deadline
  return new LlmError(`Magpie request failed (${code}${status ? `, HTTP ${status}` : ''})`, code,
    { ...(status ? { status } : {}), ...(Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}) })
}

/** Bounded SSE decoder; handles UTF-8, CR/LF, comments, multi-line data and cancellation. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let line = '', data: string[] = [], bytes = 0, afterCR = false
  const limit = 1024 * 1024
  let done = false
  try {
    while (!done) {
      const result = await abortable(reader.read(), signal)
      done = result.done
      const text = decoder.decode(result.value, { stream: !done })
      for (const ch of text) {
        if (afterCR) { afterCR = false; if (ch === '\n') continue }
        if (ch === '\r' || ch === '\n') {
          if (line === '') {
            if (data.length) yield data.join('\n')
            data = []; bytes = 0
          } else if (line.startsWith('data:')) {
            data.push(line.slice(5).replace(/^ /, ''))
          }
          line = ''; afterCR = ch === '\r'
        } else { line += ch; if (++bytes > limit) throw new LlmError('Magpie stream event exceeded the size limit', 'TRANSPORT') }
      }
    }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    if (data.length) yield data.join('\n')
  } finally {
    if (!done) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

interface TextState { index: number; kind: 'text' | 'reasoning'; text: string }
interface ToolState { index: number; id: string; name: string; arguments: string }
/** Translate choice zero; tools are buffered until their ids/names are complete. */
export async function* chatChunks(events: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  let nextIndex = 0, finish: string | undefined, sawDone = false, usage: TokenUsage | undefined
  const texts = new Map<string, TextState>()
  const tools = new Map<number, ToolState>()
  for await (const event of events) {
    signal?.throwIfAborted()
    if (event.trim() === '[DONE]') { sawDone = true; break }
    let value: ObjectValue
    try { value = object(JSON.parse(event)) } catch { throw new LlmError('Magpie returned an invalid stream event', 'TRANSPORT') }
    if (value.error) throw chatError(0, value)
    usage = chatUsage(value.usage) ?? usage
    const choices = Array.isArray(value.choices) ? value.choices : []
    for (const raw of choices) {
      const choice = object(raw)
      if (choice.index !== undefined && choice.index !== 0) continue
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason
      const delta = object(choice.delta ?? choice.message)
      for (const [field, kind] of [['reasoning_content', 'reasoning'], ['reasoning', 'reasoning'], ['content', 'text']] as const) {
        const text = delta[field]
        if (typeof text !== 'string' || text === '') continue
        let state = texts.get(kind)
        if (!state) {
          state = { index: nextIndex++, kind, text: '' }; texts.set(kind, state)
          yield { type: 'block-start', index: state.index, blockType: kind }
        }
        state.text += text
        yield { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: state.index, text }
      }
      if (Array.isArray(delta.tool_calls)) for (const rawCall of delta.tool_calls) {
        const call = object(rawCall), index = count(call.index) ?? 0, fn = object(call.function)
        let state = tools.get(index)
        if (!state) {
          state = { index: nextIndex++, id: '', name: '', arguments: '' }; tools.set(index, state)
          yield { type: 'block-start', index: state.index, blockType: 'tool-call' }
        }
        if (typeof call.id === 'string') state.id += call.id
        if (typeof fn.name === 'string') state.name += fn.name
        if (typeof fn.arguments === 'string') state.arguments += fn.arguments
      }
    }
  }
  signal?.throwIfAborted()
  // A closed connection is not a successful model completion.
  if (!finish) throw new LlmError(sawDone ? 'Magpie stream omitted its finish reason' : 'Magpie stream ended before completion', 'TRANSPORT')
  for (const state of texts.values()) yield { type: 'block-end', index: state.index, block: { type: state.kind, text: state.text } }
  for (const state of tools.values()) {
    if (!state.id || !state.name) throw new LlmError('Magpie returned an incomplete tool call', 'TRANSPORT')
    const block: ContentBlock = { type: 'tool-call', id: ToolCallId(state.id), name: state.name, arguments: state.arguments }
    yield { type: 'tool-call-delta', index: state.index, id: block.id, name: state.name, argumentsDelta: state.arguments }
    yield { type: 'block-end', index: state.index, block }
  }
  if (usage) yield { type: 'usage', usage }
  let reason: FinishReason
  if (finish === 'length' || finish === 'max_tokens') reason = { kind: 'max-tokens' }
  else if (finish === 'tool_calls' || finish === 'function_call') {
    if (!tools.size) throw new LlmError('Magpie reported tool calls without a tool', 'INVALID_RESPONSE')
    reason = { kind: 'tool-calls' }
  } else if (finish === 'stop') reason = { kind: tools.size ? 'tool-calls' : 'stop' }
  else reason = { kind: 'error', failure: { message: 'Magpie response did not complete normally', code: 'INVALID_RESPONSE' } }
  if (reason.kind === 'stop' && !texts.size && !tools.size) throw new LlmError('Magpie returned no response content', 'EMPTY_RESPONSE')
  yield { type: 'finish', reason }
}
