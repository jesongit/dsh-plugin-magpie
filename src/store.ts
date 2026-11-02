import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CatalogGroup, CatalogModel, StoredConnection } from './contracts.ts'
import { ConnectorError, normalizeUrl, object, validateKey } from './transport.ts'

function parseModel(value: unknown): CatalogModel {
  const m = object(value)
  if (!m || typeof m.id !== 'string' || !m.id || typeof m.name !== 'string' || !Array.isArray(m.efforts) || !m.efforts.every(e => typeof e === 'string')) throw new Error('model')
  const out: CatalogModel = { id: m.id, name: m.name, efforts: m.efforts as string[] }
  for (const key of ['contextWindow', 'maxTokens'] as const) {
    const v = m[key]
    if (v !== undefined) {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new Error('capacity')
      out[key] = v
    }
  }
  if (m.inputModalities !== undefined) {
    if (!Array.isArray(m.inputModalities) || !m.inputModalities.every(v => v === 'text' || v === 'image')) throw new Error('modalities')
    out.inputModalities = m.inputModalities as ('text' | 'image')[]
  }
  if (m.defaultEffort !== undefined) {
    if (typeof m.defaultEffort !== 'string' || !out.efforts.includes(m.defaultEffort)) throw new Error('effort')
    out.defaultEffort = m.defaultEffort
  }
  return out
}
export function parseStored(value: unknown): StoredConnection {
  try {
    const root = object(value)
    if (!root || root.schemaVersion !== 1 || typeof root.url !== 'string' || typeof root.gatewayUrl !== 'string' || typeof root.loginKey !== 'string' || typeof root.gatewayKey !== 'string' || typeof root.syncedAt !== 'number' || !Number.isFinite(root.syncedAt) || !Array.isArray(root.catalog)) throw new Error('shape')
    const catalog: CatalogGroup[] = root.catalog.map(value => {
      const row = object(value)
      if (!row || typeof row.route !== 'string' || !/^magpie-[a-z0-9-]+$/.test(row.route) || typeof row.upstream !== 'string' || typeof row.name !== 'string' || !Array.isArray(row.models)) throw new Error('group')
      return { route: row.route, upstream: row.upstream, name: row.name, models: row.models.map(parseModel) }
    })
    if (new Set(catalog.map(g => g.route)).size !== catalog.length) throw new Error('duplicate')
    const out: StoredConnection = { schemaVersion: 1, url: normalizeUrl(root.url), loginKey: validateKey(root.loginKey, 'login'), gatewayUrl: normalizeUrl(root.gatewayUrl, true), gatewayKey: validateKey(root.gatewayKey, 'gateway'), catalog, syncedAt: root.syncedAt }
    for (const key of ['gatewayKeyId', 'version'] as const) {
      const v = root[key]
      if (v !== undefined) { if (typeof v !== 'string') throw new Error('metadata'); out[key] = v }
    }
    return out
  } catch { throw new ConnectorError('Saved Magpie connection is invalid. The original file has been left unchanged.') }
}
function missing(error: unknown): boolean { return object(error)?.code === 'ENOENT' }
export class ConnectionStore {
  readonly path: string
  constructor(path: string) { this.path = resolve(path) }
  private async regular(): Promise<void> {
    try {
      const stat = await lstat(this.path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ConnectorError('Magpie connection storage is not a regular file.')
    } catch (error) { if (!missing(error)) throw error }
  }
  async load(): Promise<StoredConnection | undefined> {
    try {
      await this.regular()
      return parseStored(JSON.parse(await readFile(this.path, 'utf8')) as unknown)
    } catch (error) {
      if (missing(error)) return undefined
      if (error instanceof ConnectorError) throw error
      throw new ConnectorError('Cannot read saved Magpie connection. The original file has been left unchanged.')
    }
  }
  async save(connection: StoredConnection): Promise<void> {
    // Observe and validate any existing bytes before replacing; corrupt/unreadable state is never erased.
    await this.load()
    const validated = parseStored(connection)
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(validated, null, 2) + '\n', 'utf8'); await file.sync() } finally { await file.close() }
      await this.regular()
      await rename(temporary, this.path)
    } catch {
      await unlink(temporary).catch(() => {})
      throw new ConnectorError('Cannot save Magpie connection securely; previous settings were retained.')
    }
  }
  async remove(): Promise<void> {
    await this.load()
    try { await unlink(this.path) } catch (error) {
      if (!missing(error)) throw new ConnectorError('Cannot remove saved Magpie connection.')
    }
  }
}
