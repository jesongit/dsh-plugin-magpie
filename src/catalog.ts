import { createHash } from 'node:crypto'
import type { CatalogGroup, CatalogModel } from './contracts.ts'
import { ConnectorError, object } from './transport.ts'

export function providerRoute(upstream: string): string {
  const slug = upstream.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'provider'
  // Hash prevents punctuation/case and truncated names from sharing one route.
  return `magpie-${slug}-${createHash('sha256').update(upstream).digest('hex').slice(0, 10)}`
}
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value.trim().slice(0, 300) : fallback
}
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
export function providerNames(payload: unknown): ReadonlyMap<string, string> {
  const root = object(payload)
  const names = new Map<string, string>()
  if (Array.isArray(root?.providers)) for (const entry of root.providers) {
    const row = object(entry)
    if (typeof row?.id === 'string') names.set(row.id, text(row.name, row.id))
  }
  return names
}
/** Parse Magpie's actual OpenAI list, retaining full upstream dispatch ids. */
export function parseCatalog(payload: unknown, names: ReadonlyMap<string, string> = new Map()): CatalogGroup[] {
  const root = object(payload)
  if (!root || !Array.isArray(root.data)) throw new ConnectorError('Magpie model directory has an unsupported format.')
  const groups = new Map<string, CatalogGroup>()
  const seen = new Set<string>()
  for (const entry of root.data) {
    const row = object(entry)
    if (!row || typeof row.id !== 'string' || !row.id || /[\x00-\x20\x7f]/.test(row.id) || row.id.length > 2048) continue
    const id = row.id
    if (seen.has(id)) continue
    // Explicit non-chat listings should not enter a conversation model picker.
    if (typeof row.kind === 'string' && row.kind !== 'chat') continue
    const modalities = object(row.modalities)
    if (Array.isArray(modalities?.output) && !modalities.output.includes('text')) continue
    const routedGroup = id.startsWith('group/') || id.startsWith('auto/')
    const owner = typeof row.owned_by === 'string' && row.owned_by.trim() ? row.owned_by.trim() : id.includes('/') ? id.slice(0, id.indexOf('/')) : 'unknown'
    const upstream = routedGroup ? 'group' : owner
    if (/[\x00-\x1f\x7f]/.test(upstream) || upstream.length > 300) continue
    let group = groups.get(upstream)
    if (!group) {
      group = { route: providerRoute(upstream), upstream, name: `Magpie · ${routedGroup ? 'Routing groups' : names.get(upstream) ?? upstream}`, models: [] }
      groups.set(upstream, group)
    }
    const levels = Array.isArray(row.reasoning_levels) ? row.reasoning_levels : Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels.map(value => object(value)?.effort) : []
    const efforts = [...new Set(levels.filter((value): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)))]
    const model: CatalogModel = { id, name: text(row.display_name, text(row.name, id)), efforts }
    const context = positive(row.context_window) ?? positive(row.context_length) ?? positive(row.max_input_tokens)
    const maxTokens = positive(row.max_output_tokens)
    if (context !== undefined) model.contextWindow = context
    if (maxTokens !== undefined) model.maxTokens = maxTokens
    if (Array.isArray(modalities?.input)) model.inputModalities = modalities.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
    else if (typeof row.supports_vision === 'boolean') model.inputModalities = row.supports_vision ? ['text', 'image'] : ['text']
    if (typeof row.default_reasoning_effort === 'string' && efforts.includes(row.default_reasoning_effort)) model.defaultEffort = row.default_reasoning_effort
    group.models.push(model)
    seen.add(id)
  }
  if (root.data.length > 0 && seen.size === 0) throw new ConnectorError('Magpie returned no recognizable conversation models.')
  return [...groups.values()]
}
