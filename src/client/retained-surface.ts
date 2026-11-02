import type { MagpieClient } from './state.ts'

export interface SurfaceBounds { left: number; top: number; width: number; height: number }
export interface RetainedSnapshot { url: string | null; generation: number; activated: boolean; bounds: SurfaceBounds | null }
type Source = Pick<MagpieClient, 'getSnapshot' | 'subscribe'>
/** One plugin-owned surface; panel anchors only report geometry and never own/move a guest. */
export class RetainedSurface {
  private value: RetainedSnapshot = { url: null, generation: 0, activated: false, bounds: null }
  private listeners = new Set<() => void>()
  private anchor: object | null = null
  private disposed = false
  private unsubscribe: () => void
  constructor(source: Source) {
    let epoch = source.getSnapshot().connectionEpoch
    const sync = () => {
      const snapshot = source.getSnapshot()
      const status = snapshot.status
      const url = status?.configured && status.hasLoginKey ? status.url : null
      const reconnected = epoch !== snapshot.connectionEpoch
      epoch = snapshot.connectionEpoch
      if (url !== this.value.url) this.configure(url)
      else if (reconnected) this.invalidate()
    }
    this.unsubscribe = source.subscribe(sync)
    sync()
  }
  getSnapshot = (): RetainedSnapshot => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<RetainedSnapshot>): void {
    if (this.disposed) return
    this.value = { ...this.value, ...patch }
    for (const listener of this.listeners) listener()
  }
  private configure(url: string | null): void {
    if (url === this.value.url) return
    this.update({ url, generation: this.value.generation + 1, activated: !!url && this.value.bounds !== null })
  }
  /** Explicit successful reconnect invalidates an old same-URL session, never ordinary directory refresh. */
  invalidate = (): void => {
    this.update({ generation: this.value.generation + 1, activated: !!this.value.url && this.value.bounds !== null })
  }
  attach = (owner: object): void => { if (!this.disposed) this.anchor = owner }
  setBounds = (owner: object, value: SurfaceBounds): void => {
    if (this.disposed || this.anchor !== owner) return
    if (![value.left, value.top, value.width, value.height].every(Number.isFinite) || value.width <= 0 || value.height <= 0) {
      if (this.value.bounds) this.update({ bounds: null })
      return
    }
    const old = this.value.bounds
    if (old && old.left === value.left && old.top === value.top && old.width === value.width && old.height === value.height) return
    this.update({ bounds: { ...value }, activated: this.value.activated || this.value.url !== null })
  }
  detach = (owner: object): void => {
    if (this.disposed || this.anchor !== owner) return
    this.anchor = null
    if (this.value.bounds) this.update({ bounds: null })
  }
  dispose(): void {
    if (this.disposed) return
    this.unsubscribe()
    this.value = { url: null, generation: this.value.generation + 1, activated: false, bounds: null }
    for (const listener of this.listeners) listener()
    this.disposed = true
    this.anchor = null
    this.listeners.clear()
  }
}
