import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectInput, QuotaView, StatusView } from '../contracts.ts'

export interface ClientSnapshot { status: StatusView | null; busy: boolean; error: string | null; quota: QuotaView | null; connectionEpoch: number }
export class MagpieClient {
  private snapshot: ClientSnapshot = { status: null, busy: false, error: null, quota: null, connectionEpoch: 0 }
  private listeners = new Set<() => void>()
  private reading: Promise<void> | undefined
  private fetchedAt = 0
  private quotaReading: Promise<void> | undefined
  private disposed = false
  private generation = 0
  private rpc: ConnectionHandle['rpc']
  constructor(rpc: ConnectionHandle['rpc']) { this.rpc = rpc }
  getSnapshot = (): ClientSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<ClientSnapshot>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
  private async call<T>(endpoint: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> {
    const result = await this.rpc.call('/api', `magpie.${endpoint}`, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
  read = (force = false): Promise<void> => {
    if (this.reading) return this.reading
    if (!force && Date.now() - this.fetchedAt < 30_000) return Promise.resolve()
    const generation = this.generation
    const job = this.call<StatusView>('status').then(status => {
      if (generation !== this.generation) return
      this.fetchedAt = Date.now(); this.update({ status, error: null })
    }).catch(() => { if (generation === this.generation) this.update({ error: '无法读取 Magpie 连接状态，请刷新页面或检查插件是否启用。' }) })
      .finally(() => { if (this.reading === job) this.reading = undefined })
    this.reading = job
    return job
  }
  private async mutate(endpoint: 'connect' | 'refresh' | 'disconnect', payload: unknown): Promise<boolean> {
    if (this.snapshot.busy) return false
    ++this.generation
    this.reading = undefined
    this.quotaReading = undefined
    this.update({ busy: true, error: null })
    try {
      const status = await this.call<StatusView>(endpoint, payload)
      this.fetchedAt = Date.now()
      this.update({ status, quota: null, connectionEpoch: this.snapshot.connectionEpoch + (endpoint === 'connect' || endpoint === 'disconnect' ? 1 : 0) })
      return true
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : '操作未完成，请重试。' })
      return false
    } finally { this.update({ busy: false }) }
  }
  connect = (input: ConnectInput): Promise<boolean> => this.mutate('connect', input)
  refresh = (): Promise<boolean> => this.mutate('refresh', {})
  disconnect = (): Promise<boolean> => this.mutate('disconnect', {})
  quotas = (): Promise<void> => {
    if (this.quotaReading) return this.quotaReading
    const generation = this.generation
    const job = this.call<QuotaView>('quotas').then(quota => { if (generation === this.generation) this.update({ quota }) })
      // A failed read means unknown, not empty: keep the last good providers so the popup stays honest.
      .catch(() => { if (generation === this.generation) { const previous = this.snapshot.quota; this.update({ quota: { updatedAt: previous?.updatedAt ?? null, stale: true, error: '暂时无法读取额度；不影响模型调用。', summaries: previous?.summaries ?? [], ...(previous?.providers === undefined ? {} : { providers: previous.providers }) } }) } })
      .finally(() => { if (this.quotaReading === job) this.quotaReading = undefined })
    this.quotaReading = job
    return job
  }
  // Bootstrap replies are ephemeral: never merge token or POST body into public snapshots.
  launchIssue = (signal?: AbortSignal): Promise<{ token: string; expiresAt: number }> => this.call('launch.issue', {}, signal)
  launchRedeem = (token: string, signal?: AbortSignal): Promise<{ url: string; body: string }> => this.call('launch.redeem', { token }, signal)
  launchRevoke = async (token: string): Promise<void> => { await this.call('launch.revoke', { token }) }
  speed = (sessionId: string, provider: string, model: string): Promise<{ tier: 'standard' | 'fast'; visible: boolean; fastTier: boolean }> =>
    this.call('speed', { sessionId, provider, model })
  setSpeed = (sessionId: string, tier: 'standard' | 'fast'): Promise<void> => this.call('setSpeed', { sessionId, tier })
  dispose(): void { this.disposed = true; this.listeners.clear() }
}
