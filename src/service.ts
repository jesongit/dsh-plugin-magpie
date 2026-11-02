import { randomUUID } from 'node:crypto'
import type { LaunchIdentity } from './launch.ts'
import type { CallTarget, CatalogGroup, ConnectInput, QuotaView, StatusView, StoredConnection } from './contracts.ts'
import { parseCatalog, providerNames } from './catalog.ts'
import { ConnectionStore } from './store.ts'
import { normalizeQuotas } from './quota.ts'
import { ConnectorError, isLoopback, MagpieTransport, normalizeUrl, object, safeError, validateKey } from './transport.ts'

export interface MagpieServiceOptions {
  storePath: string
  fetch?: typeof fetch
  onCatalogChanged?: () => void
}

/** Stable gateway selection: a remote management server's loopback is NOT this DSH host. */
export function discoverGateway(managementUrl: string, payload: unknown, override?: string): string {
  if (override?.trim()) return normalizeUrl(override, true)
  const gateway = object(object(payload)?.gateway)
  if (typeof gateway?.url !== 'string') throw new ConnectorError('Magpie did not report a gateway URL. Set an explicit gateway URL in advanced settings.')
  const candidate = normalizeUrl(gateway.url, true)
  if (isLoopback(managementUrl)) {
    // Local Magpie may use a separate port, but a server-reported foreign target must never receive credentials silently.
    if (isLoopback(candidate)) return candidate
  } else if (!isLoopback(candidate) && new URL(candidate).hostname === new URL(managementUrl).hostname && !(new URL(managementUrl).protocol === 'https:' && new URL(candidate).protocol !== 'https:')) {
    return candidate
  }
  // Magpie web's own page port serves /v1 too. It requires sharing plus a gateway key;
  // a refusal is reported rather than changing sharing or guessing another host/port.
  return normalizeUrl(managementUrl, true)
}

export class MagpieService {
  private readonly store: ConnectionStore
  private readonly transport: MagpieTransport
  private readonly onCatalogChanged: (() => void) | undefined
  private connection: StoredConnection | undefined
  private connected = false
  private stale = false
  private error: string | null = null
  private disposed = false
  private readonly lifetime = new AbortController()
  private generation = 0
  // Dedicated browser identity: metadata refreshes do not invalidate launch tickets.
  private connectionRevision = 0
  private operation: AbortController | undefined
  private refreshJob: Promise<StatusView> | undefined
  private quotaJob: Promise<QuotaView> | undefined
  private quotaOperation: AbortController | undefined
  private quotaCache: QuotaView = { updatedAt: null, stale: false, error: null, summaries: [] }
  private quotaExpires = 0
  private mutation: Promise<void> = Promise.resolve()

  constructor(options: MagpieServiceOptions) {
    this.store = new ConnectionStore(options.storePath)
    this.transport = new MagpieTransport(options.fetch)
    this.onCatalogChanged = options.onCatalogChanged
  }
  private assertLive(): void { if (this.disposed) throw new ConnectorError('Magpie connector has been disposed.') }
  private publish(): void { try { this.onCatalogChanged?.() } catch { /* Observers cannot veto a committed generation. */ } }
  private serial<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(callback, callback)
    this.mutation = result.then(() => {}, () => {})
    return result
  }
  private begin(signal?: AbortSignal): { generation: number; signal: AbortSignal } {
    this.assertLive()
    this.operation?.abort()
    this.operation = new AbortController()
    this.generation++
    return { generation: this.generation, signal: AbortSignal.any([this.operation.signal, this.lifetime.signal, ...(signal ? [signal] : [])]) }
  }
  private current(generation: number, signal: AbortSignal): void {
    if (this.disposed || generation !== this.generation || signal.aborted) throw new ConnectorError('Magpie operation was cancelled.')
  }
  async initialize(): Promise<void> {
    this.assertLive()
    if (this.connection) return
    try {
      const connection = await this.store.load()
      if (!connection || this.disposed) return
      this.connection = connection
      this.stale = true
      this.publish()
      await this.refresh()
    } catch (error) {
      this.error = safeError(error)
      this.stale = true
    }
  }
  status(): StatusView {
    const connection = this.connection
    const groups = connection?.catalog ?? []
    return {
      configured: connection !== undefined, connected: this.connected,
      url: connection?.url ?? '', gatewayUrl: connection?.gatewayUrl ?? '',
      hasLoginKey: Boolean(connection?.loginKey), hasGatewayKey: Boolean(connection?.gatewayKey),
      groups: groups.map(group => ({ route: group.route, upstream: group.upstream, name: group.name, models: group.models.length })),
      modelCount: groups.reduce((count, group) => count + group.models.length, 0),
      syncedAt: connection?.syncedAt ?? null, stale: this.stale, error: this.error, version: connection?.version ?? null,
    }
  }
  /** Server-only saved management identity, detached from catalog refresh generations. */
  launchIdentity(): LaunchIdentity {
    this.assertLive()
    const connection = this.connection
    if (!connection?.loginKey) throw new ConnectorError('Magpie backend connection is not configured.')
    return { url: connection.url, loginKey: connection.loginKey, revision: this.connectionRevision }
  }
  catalog(): readonly CatalogGroup[] { return structuredClone(this.connection?.catalog ?? []) }
  capture(provider: string, model: string): CallTarget {
    this.assertLive()
    const connection = this.connection
    const entry = connection?.catalog.find(group => group.route === provider)?.models.find(entry => entry.id === model)
    if (!connection || !entry) throw new ConnectorError('This Magpie model route is no longer available. Refresh the model directory.')
    // Deeply frozen detached generation: reconfiguration must not change a prepared call.
    const copied = structuredClone(entry)
    Object.freeze(copied.efforts)
    if (copied.inputModalities) Object.freeze(copied.inputModalities)
    Object.freeze(copied)
    return Object.freeze({ gatewayUrl: connection.gatewayUrl, gatewayKey: connection.gatewayKey, provider, model: copied })
  }

  async connect(input: ConnectInput, signal?: AbortSignal): Promise<StatusView> {
    return this.serial(async () => {
      const operation = this.begin(signal)
      let createdId: string | undefined
      let cookie: string | undefined
      let url: string | undefined
      let createdName: string | undefined
      try {
        url = normalizeUrl(input.url)
        const loginKey = validateKey(input.loginKey.trim() || (this.connection?.url === url ? this.connection.loginKey : ''), 'login')
        cookie = await this.transport.login(url, loginKey, operation.signal)
        const providers = await this.transport.management(url, cookie, '/api/providers', undefined, operation.signal)
        const gatewayUrl = discoverGateway(url, providers, input.gatewayUrl)
        const old = this.connection
        const mayReuse = old?.url === url && old.loginKey === loginKey && old.gatewayUrl === gatewayUrl
        let gatewayKey = input.gatewayKey?.trim() ? validateKey(input.gatewayKey, 'gateway') : mayReuse ? old.gatewayKey : undefined
        let gatewayKeyId = mayReuse && !input.gatewayKey?.trim() ? old.gatewayKeyId : undefined
        if (!gatewayKey && input.createGatewayKey === true) {
          createdName = `DSH Magpie ${randomUUID()}`
          const result = object(await this.transport.management(url, cookie, '/api/caller-keys/add-key', { name: createdName, readOnly: true }, operation.signal))
          const keys = Array.isArray(result?.keys) ? result.keys : []
          const key = keys.map(object).find(entry => entry?.name === createdName && typeof entry?.id === 'string')
          if (typeof key?.id === 'string') createdId = key.id
          if (!createdId || typeof result?.secret !== 'string') throw new ConnectorError('Magpie did not return a usable dedicated gateway key.')
          gatewayKey = validateKey(result.secret, 'gateway')
          gatewayKeyId = createdId
          // Read-only keys deliberately cannot list /v1/models. Explicit consent covers activation;
          // any later validation/persistence failure removes ONLY this newly created key.
          await this.transport.management(url, cookie, '/api/caller-keys/access-key', { key: createdId, readOnly: false }, operation.signal)
        }
        if (!gatewayKey) throw new ConnectorError('Provide a gateway key or explicitly allow creating a dedicated DSH gateway key.')
        const groups = parseCatalog(await this.transport.gateway({ gatewayUrl, gatewayKey }, '/v1/models', operation.signal), providerNames(providers))
        const connection: StoredConnection = { schemaVersion: 1, url, loginKey, gatewayUrl, gatewayKey, catalog: groups, syncedAt: Date.now() }
        if (gatewayKeyId !== undefined) connection.gatewayKeyId = gatewayKeyId
        // /api/state.settings.version is emitted by settingsJSON; provider gateway.version can name another instance.
        const state = object(await this.transport.management(url, cookie, '/api/state', undefined, operation.signal))
        const version = object(state?.settings)?.version
        if (typeof version === 'string' && /^[a-zA-Z0-9.+_-]{1,100}$/.test(version)) connection.version = version
        this.current(operation.generation, operation.signal)
        await this.store.save(connection)
        // Once persisted, never revoke this generation's credential on a late cancellation.
        createdName = undefined
        // Persistence is the commit point; late caller cancellation cannot roll it back.
        if (this.disposed) return this.status()
        this.connection = connection
        this.connectionRevision++
        this.connected = true
        this.stale = false
        this.error = null
        this.quotaOperation?.abort()
        this.quotaJob = undefined
        this.quotaExpires = 0
        this.quotaCache = { updatedAt: null, stale: false, error: null, summaries: [] }
        this.publish()
        return this.status()
      } catch (error) {
        let cleanupFailed = false
        if (cookie && url && createdName) {
          try {
            // A malformed/aborted create response may still have written the key. Recover its unique id.
            if (!createdId) {
              const listing = object(await this.transport.management(url, cookie, '/api/caller-keys'))
              const key = (Array.isArray(listing?.keys) ? listing.keys : []).map(object).find(entry => entry?.name === createdName)
              if (typeof key?.id === 'string') createdId = key.id
            }
            if (createdId) await this.transport.management(url, cookie, '/api/caller-keys/remove-key', { key: createdId })
          } catch { cleanupFailed = true }
        }
        if (operation.generation === this.generation && !this.disposed) {
          this.error = safeError(error) + (cleanupFailed ? ' The new gateway key could not be revoked; check DSH keys in Magpie.' : '')
          this.stale = this.connection !== undefined
          // A failed replacement leaves the old, known connection and its routes intact.
        }
        throw new ConnectorError(safeError(error) + (cleanupFailed ? ' The new gateway key could not be revoked; check DSH keys in Magpie.' : ''))
      }
    })
  }

  refresh(signal?: AbortSignal): Promise<StatusView> {
    this.assertLive()
    if (this.refreshJob) return this.refreshJob
    const job = this.serial(async () => {
      const connection = this.connection
      if (!connection) return this.status()
      const operation = this.begin(signal)
      try {
        const cookie = await this.transport.login(connection.url, connection.loginKey, operation.signal)
        const providers = await this.transport.management(connection.url, cookie, '/api/providers', undefined, operation.signal)
        const catalog = parseCatalog(await this.transport.gateway(connection, '/v1/models', operation.signal), providerNames(providers))
        const next: StoredConnection = { ...connection, catalog, syncedAt: Date.now() }
        this.current(operation.generation, operation.signal)
        await this.store.save(next)
        if (this.disposed) return this.status()
        this.connection = next
        this.connected = true
        this.stale = false
        this.error = null
        this.publish()
      } catch (error) {
        if (!this.disposed && operation.generation === this.generation) {
          this.connected = false
          this.stale = true
          this.error = safeError(error)
        }
      }
      return this.status()
    })
    this.refreshJob = job
    void job.finally(() => { if (this.refreshJob === job) this.refreshJob = undefined }).catch(() => {})
    return job
  }

  async disconnect(): Promise<StatusView> {
    this.assertLive()
    this.operation?.abort()
    this.quotaOperation?.abort()
    this.quotaJob = undefined
    this.generation++
    return this.serial(async () => {
      this.assertLive()
      await this.store.remove()
      this.connection = undefined
      this.connectionRevision++
      this.connected = false
      this.stale = false
      this.error = null
      this.quotaCache = { updatedAt: null, stale: false, error: null, summaries: [] }
      this.quotaExpires = 0
      this.publish()
      return this.status()
    })
  }

  quotas(signal?: AbortSignal): Promise<QuotaView> {
    this.assertLive()
    if (!this.connection) return Promise.resolve(structuredClone(this.quotaCache))
    if (Date.now() < this.quotaExpires) return Promise.resolve(structuredClone(this.quotaCache))
    if (this.quotaJob) return this.quotaJob.then(value => structuredClone(value))
    const connection = this.connection
    const generation = this.generation
    this.quotaOperation = new AbortController()
    const quotaOperation = this.quotaOperation
    const job = (async (): Promise<QuotaView> => {
      try {
        // Kept snapshots never trigger subscription vendor requests just for a status pill.
        const quotaSignal = AbortSignal.any([this.lifetime.signal, quotaOperation.signal, ...(signal ? [signal] : [])])
        const payload = await this.transport.gateway(connection, '/v1/magpie/quotas?kept=1', quotaSignal)
        const normalized = normalizeQuotas(payload, connection.catalog, Date.now(), [connection.loginKey, connection.gatewayKey])
        if (this.connection === connection && this.generation === generation && !this.disposed) {
          this.quotaCache = { updatedAt: Date.now(), stale: false, error: null, ...normalized }
          this.quotaExpires = Date.now() + 30_000
        }
      } catch (error) {
        if (this.connection === connection && this.generation === generation && !this.disposed) {
          this.quotaCache = { ...this.quotaCache, stale: true, error: safeError(error) }
          this.quotaExpires = Date.now() + 5_000
        }
      }
      return structuredClone(this.quotaCache)
    })()
    this.quotaJob = job
    void job.finally(() => { if (this.quotaJob === job) this.quotaJob = undefined }).catch(() => {})
    return job.then(value => structuredClone(value))
  }
  dispose(): void {
    this.disposed = true
    this.lifetime.abort()
    this.operation?.abort()
    this.generation++
  }
}
