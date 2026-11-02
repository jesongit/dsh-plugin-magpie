/** One thin Chat Completions adapter owns every Magpie group; Magpie owns account routing. */
import { LlmAdapter, LlmError, ReasoningEffortId, attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CallTarget, CatalogGroup, CatalogModel } from './contracts.js'
import { abortable, chatChunks, chatError, chatRequest, sseData } from './protocol.ts'

export interface MagpieAdapterService {
  catalog(): readonly CatalogGroup[]
  capture(provider: string, model: string): CallTarget
}
export interface MagpieAdapterOptions {
  fetch?: typeof fetch
  resolveAttachments?: () => AttachmentStore | undefined
}
function metadata(provider: string, model: CatalogModel): LlmResolvedModelInfo {
  return { provider, id: model.id, name: model.name,
    ...(model.inputModalities !== undefined ? { inputModalities: [...model.inputModalities] } : {}),
    ...(model.contextWindow !== undefined ? { context: { contextWindow: model.contextWindow } } : {}),
    ...(model.maxTokens !== undefined ? { defaultMaxTokens: model.maxTokens } : {}),
    ...(model.efforts.length ? { reasoning: {
      efforts: model.efforts.map(effort => ({ id: ReasoningEffortId(effort), name: effort })),
      ...(model.defaultEffort !== undefined && model.efforts.includes(model.defaultEffort) ? { defaultEffort: ReasoningEffortId(model.defaultEffort) } : {}),
    } } : {}),
  }
}
function freezeTarget(value: CallTarget): CallTarget {
  const target = structuredClone(value)
  Object.freeze(target.model.efforts)
  if (target.model.inputModalities) Object.freeze(target.model.inputModalities)
  Object.freeze(target.model)
  return Object.freeze(target)
}
export class MagpieAdapter extends LlmAdapter {
  private readonly fetcher: typeof fetch
  private readonly attachments: (() => AttachmentStore | undefined) | undefined
  private readonly service: MagpieAdapterService
  constructor(service: MagpieAdapterService, options: MagpieAdapterOptions | (() => AttachmentStore | undefined) = {}) {
    super()
    this.service = service
    const config = typeof options === 'function' ? { resolveAttachments: options } : options
    this.fetcher = config.fetch ?? globalThis.fetch
    this.attachments = config.resolveAttachments
  }
  override providerInfo(provider: string) {
    return { id: provider, name: this.service.catalog().find(group => group.route === provider)?.name ?? provider }
  }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const group = this.service.catalog().find(entry => entry.route === provider)
    return group?.models.map(model => metadata(provider, model)) ?? []
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    return metadata(provider, this.service.capture(provider, model).model)
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted()
    const target = freezeTarget(this.service.capture(provider, model))
    return { model: metadata(provider, target.model), stream: options => this.send(options, target) }
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Capture inside the generator so missing-route failures use the same failure boundary.
    const self = this
    return (async function* () { yield* self.send(options, freezeTarget(self.service.capture(options.provider, options.model))) })()
  }
  private async *send(options: GenerateOptions, target: CallTarget): AsyncGenerator<StreamChunk> {
    if (options.provider !== target.provider || options.model !== target.model.id) throw new LlmError('Prepared Magpie call identity changed', 'INVALID_PREPARED_CALL')
    const consumer = new AbortController()
    const signal = options.signal ? AbortSignal.any([consumer.signal, options.signal]) : consumer.signal
    let response: Response | undefined
    try {
      signal.throwIfAborted()
      const request = await chatRequest({ ...options, signal }, target.model, this.attachments?.())
      const url = `${target.gatewayUrl.replace(/\/+$/, '')}/v1/chat/completions`
      const headers = new Headers(attributionHeaders())
      headers.set('Authorization', `Bearer ${target.gatewayKey}`)
      headers.set('Content-Type', 'application/json')
      headers.set('Accept', 'text/event-stream')
      if (options.sessionId) headers.set('X-Magpie-Session', String(options.sessionId))
      const pending = this.fetcher(url, { method: 'POST', headers, body: JSON.stringify(request), signal, redirect: 'error' })
      // If a nonconforming fetch resolves after cancellation, release its body too.
      void pending.then(result => { if (signal.aborted) void result.body?.cancel().catch(() => {}) }, () => {})
      response = await abortable(pending, signal)
      if (!response.ok) {
        let error: unknown
        try { error = await abortable(response.json(), signal) } catch { error = undefined }
        throw chatError(response.status, error, response.headers.get('retry-after'))
      }
      if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        throw new LlmError('Magpie did not return a Chat Completions event stream', 'INVALID_RESPONSE')
      }
      yield* chatChunks(sseData(response.body, signal), signal)
    } catch (error) {
      if (signal.aborted) throw new LlmError('Magpie request cancelled', 'ABORTED')
      if (error instanceof LlmError) throw error
      // Fetch/attachment errors can contain a URL, authorization header or raw body.
      throw new LlmError('Magpie request could not complete', 'TRANSPORT')
    } finally {
      consumer.abort()
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
    }
  }
}
