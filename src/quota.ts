import type { CatalogGroup, QuotaAccountView, QuotaProviderView, QuotaView, QuotaWindowView } from './contracts.ts'
import { object } from './transport.ts'

const MAX_ROWS = 256
const MAX_WINDOWS = 64
const STALE_MS = 5 * 60_000
const MIN_EPOCH = Date.UTC(2000, 0, 1)
const MAX_EPOCH = Date.UTC(2100, 0, 1)
/** Public text is a bounded display value, not an account identifier or raw error. */
function text(value: unknown, max: number, secrets: readonly string[]): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u00a0\u1680\u2000-\u200f\u202a-\u202e\u2060-\u2069\u2028\u2029\ufeff\ufffe\uffff]/g, '').replace(/[\uff20\uff21-\uff5a\uff3a\uff01-\uff19]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0)).trim()
  if (!clean || clean.length > max || /@|https?:|\bBearer\b|\b(?:api[ _-]?key|token|secret|password)\b|\bsk[-_][a-z0-9_-]{8,}/i.test(clean) || secrets.some(secret => secret.length > 0 && clean.includes(secret))) return undefined
  return clean
}
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15 ? value : undefined }
function percentage(value: unknown): number | undefined { const n = number(value); return n === undefined ? undefined : Math.max(0, Math.min(100, n)) }
function epoch(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN
  return Number.isFinite(n) && n >= MIN_EPOCH && n < MAX_EPOCH ? n : undefined
}
function windowView(value: unknown, ordinal: number, secrets: readonly string[]): QuotaWindowView | undefined {
  const win = object(value)
  if (!win) return undefined
  const label = text(win.name, 80, secrets) ?? `窗口${ordinal}`
  const display = text(win.display, 160, secrets)
  const balance = number(win.balance)
  const used = percentage(win.used)
  const remaining = percentage(win.remaining)
  let result: QuotaWindowView
  if (win.unlimited === true) result = { kind: 'unlimited', label }
  else if (win.text === true) {
    if (!display) return undefined
    result = { kind: 'text', label }
  } else if (balance !== undefined) result = { kind: 'balance', label, amount: balance }
  else if (remaining !== undefined || used !== undefined) result = { kind: 'percentage', label, remaining: remaining ?? 100 - used!, used: used ?? 100 - remaining! }
  else return undefined
  const amount = number(win.amount)
  const limit = number(win.limit)
  const unit = text(win.unit, 40, secrets)
  const pool = text(win.pool, 80, secrets)
  const resetsAt = epoch(win.resetsAt)
  const runsOutAt = epoch(win.runsOutAt)
  if (result.kind !== 'balance' && amount !== undefined && amount >= 0) result.amount = amount
  if (limit !== undefined && limit > 0) result.limit = limit
  if (unit) result.unit = unit
  if (pool) result.pool = pool
  if (display) result.display = display
  if (resetsAt !== undefined) result.resetsAt = resetsAt
  if (runsOutAt !== undefined) result.runsOutAt = runsOutAt
  return result
}

/** Gateway kept=1 snapshots are provider-wide: never infer a model or selected account. */
export function normalizeQuotas(payload: unknown, catalog: readonly CatalogGroup[], now: number, secrets: readonly string[] = []): Pick<QuotaView, 'summaries' | 'providers'> {
  const root = object(payload)
  if (!Array.isArray(root?.data)) throw new Error('Unsupported quota snapshot')
  const byProvider = new Map<string, QuotaProviderView>()
  for (const value of root.data.slice(0, MAX_ROWS)) {
    const row = object(value)
    if (typeof row?.provider !== 'string' || !/^[a-zA-Z0-9_.-]{1,200}$/.test(row.provider)) continue
    const providerId = row.provider
    if (secrets.some(secret => secret && providerId.includes(secret))) continue
    let provider = byProvider.get(providerId)
    if (!provider) {
      const group = catalog.find(group => group.upstream === row.provider)
      provider = { provider: row.provider, label: text(group?.name, 80, secrets) ?? `Magpie · ${row.provider.slice(0, 71)}`, accounts: [] }
      byProvider.set(row.provider, provider)
    }
    const ordinal = provider.accounts.length + 1
    const windows = (Array.isArray(row.windows) ? row.windows.slice(0, MAX_WINDOWS) : []).map((win, index) => windowView(win, index + 1, secrets)).filter((win): win is QuotaWindowView => !!win)
    const balance = text(row.balance, 160, secrets)
    const plan = text(row.plan, 80, secrets)
    const reading = epoch(row.readAt) ?? epoch(row.asOf)
    const readAt = reading !== undefined && reading <= now + 60_000 ? reading : undefined
    const unavailable = Boolean(row.error) || (windows.length === 0 && !balance)
    const account: QuotaAccountView = {
      id: `account-${ordinal}`, label: `账号${ordinal}`,
      kind: row.kind === 'subscription' || row.kind === 'plan' || row.kind === 'balance' ? row.kind : 'unknown',
      windows, unavailable, ...(typeof row.sharedBalance === 'string' && row.sharedBalance ? { sharedBalance: true } : {}),
      stale: unavailable || row.readDeferred === true || readAt === undefined || now - readAt > STALE_MS,
      ...(readAt === undefined ? {} : { readAt }), ...(balance ? { balance } : {}), ...(plan ? { plan } : {}),
    }
    provider.accounts.push(account)
  }
  const providers = [...byProvider.values()]
  const summaries = providers.map(group => {
    const remaining = group.accounts.flatMap(account => account.windows.filter(win => win.kind === 'percentage' && win.remaining !== undefined).map(win => win.remaining!))
    const unavailable = group.accounts.filter(account => account.unavailable).length
    const reading = remaining.length ? `Lowest window ${Math.round(Math.min(...remaining))}% remaining` : 'No percentage reading'
    return { provider: group.provider, label: group.label, text: `${reading} · ${group.accounts.length} account(s)${unavailable ? ` · ${unavailable} unavailable` : ''}` }
  })
  return { providers, summaries }
}
