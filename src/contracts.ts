/** JSON-only connector contracts. Never put credentials in public views. */
export interface ConnectInput {
  url: string
  loginKey: string
  createGatewayKey: boolean
  gatewayUrl?: string
  gatewayKey?: string
}
export interface CatalogModel {
  /** Full upstream model id, retained verbatim for dispatch. */
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: ('text' | 'image')[]
  efforts: string[]
  defaultEffort?: string
}
export interface CatalogGroup {
  /** Namespaced DSH route; never collides with Codex/WorkBuddy direct plugins. */
  route: string
  upstream: string
  name: string
  models: CatalogModel[]
}
export interface StatusView {
  configured: boolean
  connected: boolean
  url: string
  gatewayUrl: string
  hasLoginKey: boolean
  hasGatewayKey: boolean
  groups: { route: string; upstream: string; name: string; models: number }[]
  modelCount: number
  syncedAt: number | null
  stale: boolean
  error: string | null
  version: string | null
}
export interface QuotaWindowView {
  kind: 'percentage' | 'balance' | 'text' | 'unlimited'
  label: string
  remaining?: number
  used?: number
  amount?: number
  limit?: number
  unit?: string
  display?: string
  resetsAt?: number
  runsOutAt?: number
  pool?: string
}
export interface QuotaAccountView {
  /** Snapshot ordinal only, not an upstream account selector or stable identity. */
  id: string
  label: string
  plan?: string
  kind: 'subscription' | 'plan' | 'balance' | 'unknown'
  windows: QuotaWindowView[]
  balance?: string
  /** Upstream marks this balance as shared; never sum it across accounts. */
  sharedBalance?: boolean
  unavailable: boolean
  readAt?: number
  stale: boolean
}
export interface QuotaProviderView {
  provider: string
  label: string
  accounts: QuotaAccountView[]
}
export interface QuotaView {
  updatedAt: number | null
  stale: boolean
  error: string | null
  summaries: { provider: string; label: string; text: string }[]
  /** Provider-wide shared quota snapshots, never asserted as model/account routing. */
  providers?: QuotaProviderView[]
}
/** Server-only immutable generation. Do not serialize to the client. */
export interface CallTarget {
  gatewayUrl: string
  gatewayKey: string
  provider: string
  model: CatalogModel
}
export interface StoredConnection {
  schemaVersion: 1
  url: string
  loginKey: string
  gatewayUrl: string
  gatewayKey: string
  gatewayKeyId?: string
  version?: string
  catalog: CatalogGroup[]
  syncedAt: number
}
