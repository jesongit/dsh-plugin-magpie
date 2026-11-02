import type { StatusView } from '../contracts.ts'

export interface ModelSelection { provider: string; model: string }
interface DirectorySnapshot { current?: unknown; status?: unknown }
interface SelectionStore {
  getSnapshot(): DirectorySnapshot
  subscribe(listener: () => void): () => void
}
/** Sanctioned modelDirectories service, mirrored structurally; no private RPC or vendor data. */
export interface ModelDirectoriesLike {
  directoryFor(sessionId: string): {
    load(): Promise<DirectorySnapshot>
    /** rc.5 exposes the shared observable backing the model picker. Older hosts may omit it. */
    store?: SelectionStore
  }
}
export interface CurrentModelReader {
  (): Promise<ModelSelection | undefined>
  /** Undefined means that this host/service has no observable yet; use bounded polling instead. */
  subscribe?(listener: (selection: ModelSelection | undefined) => void): (() => void) | undefined
}
function selectionOf(value: unknown): ModelSelection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const model = value as Partial<ModelSelection>
  return typeof model.provider === 'string' && model.provider.length > 0 && typeof model.model === 'string' && model.model.length > 0
    ? { provider: model.provider, model: model.model } : undefined
}
function snapshotSelection(snapshot: DirectorySnapshot): ModelSelection | undefined {
  return snapshot.status === 'error' ? undefined : selectionOf(snapshot.current)
}
export function createCurrentModelReader(models: () => ModelDirectoriesLike | undefined, sessionId: string): CurrentModelReader {
  const read: CurrentModelReader = async () => {
    const directories = models()
    if (!directories) return undefined
    return snapshotSelection(await directories.directoryFor(sessionId).load())
  }
  read.subscribe = listener => {
    const store = models()?.directoryFor(sessionId).store
    if (!store || typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') return undefined
    return store.subscribe(() => {
      try { listener(snapshotSelection(store.getSnapshot())) } catch { listener(undefined) }
    })
  }
  return read
}

/** Session-local external source: no reads until mounted consumers subscribe, no stale retained selection. */
export class ModelSelectionSource {
  private value: ModelSelection | undefined
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private stopWatching: (() => void) | undefined
  private inflight = false
  private generation = 0
  private revision = 0
  private disposed = false
  private readonly reader: CurrentModelReader
  constructor(reader: CurrentModelReader) { this.reader = reader }
  getSnapshot = (): ModelSelection | undefined => this.value
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.generation++
      this.timer = setInterval(() => { this.watch(); void this.refresh() }, 3000)
      this.watch()
      void this.refresh()
    }
    let removed = false
    return () => {
      if (removed) return
      removed = true
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }
  private active(): boolean { return !this.disposed && this.listeners.size > 0 }
  private publish(value: ModelSelection | undefined): void {
    if (this.value?.provider === value?.provider && this.value?.model === value?.model) return
    this.value = value
    for (const listener of this.listeners) listener()
  }
  private watch(): void {
    if (!this.active() || this.stopWatching || !this.reader.subscribe) return
    const generation = this.generation
    try {
      const cleanup = this.reader.subscribe(value => {
        if (!this.active() || generation !== this.generation) return
        this.revision++
        this.publish(selectionOf(value))
      })
      if (cleanup) {
        this.stopWatching = cleanup
        if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined }
      }
    } catch { this.publish(undefined) }
  }
  private async refresh(): Promise<void> {
    if (!this.active() || this.inflight) return
    this.inflight = true
    const generation = this.generation
    const revision = this.revision
    try {
      const selection = await this.reader()
      if (this.active() && generation === this.generation && revision === this.revision) this.publish(selectionOf(selection))
    } catch {
      if (this.active() && generation === this.generation && revision === this.revision) this.publish(undefined)
    } finally {
      this.inflight = false
      // A new mount may have waited for an obsolete, non-cancellable read. Start its own fresh read now.
      if (this.active() && generation !== this.generation) void this.refresh()
    }
  }
  private stop(): void {
    this.generation++
    if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined }
    const cleanup = this.stopWatching
    this.stopWatching = undefined
    try { cleanup?.() } catch { /* owning service may already have disposed */ }
    this.value = undefined
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.listeners.clear()
  }
}

/** Match only the exact registered DSH route, never a brand/model-name heuristic. */
export function selectedMagpieGroup(selection: ModelSelection | undefined, status: StatusView | null | undefined): StatusView['groups'][number] | undefined {
  if (!selection || !status?.configured) return undefined
  const group = status.groups.find(group => group.route === selection.provider)
  return group && typeof group.upstream === 'string' && group.upstream.trim() ? group : undefined
}
