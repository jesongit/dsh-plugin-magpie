import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type SpeedTier = 'standard' | 'fast'
const DEFAULT_PREFERENCE: SpeedTier = 'standard'
const MAX_SESSIONS = 256

/** Session tier overrides plus the remembered default, persisted 0600. */
export class SpeedStore {
  private preference: SpeedTier = DEFAULT_PREFERENCE
  private sessions = new Map<string, SpeedTier>()
  private readonly path: string
  constructor(path: string) {
    this.path = path
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as { tier?: unknown }
      this.preference = saved.tier === 'fast' ? 'fast' : 'standard'
    } catch { /* missing or unreadable state keeps the standard default */ }
  }
  tier(sessionId: string): SpeedTier {
    return this.sessions.get(sessionId) ?? this.preference
  }
  set(sessionId: string, tier: SpeedTier): void {
    this.preference = tier
    this.sessions.set(sessionId, tier)
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest !== undefined) this.sessions.delete(oldest)
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(`${this.path}.tmp`, JSON.stringify({ tier: this.preference }), { mode: 0o600, flag: 'w' })
      renameSync(`${this.path}.tmp`, this.path)
    } catch { /* tier is still effective in memory; persistence is best-effort */ }
  }
}
