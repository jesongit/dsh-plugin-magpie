import { randomBytes } from 'node:crypto'
import { normalizeUrl, validateKey } from './transport.ts'

/** Server-only identity. Never put the login key or a launch descriptor in public status. */
export interface LaunchIdentity { url: string; loginKey: string; revision: number }
export interface LaunchIssue { token: string; expiresAt: number }
export interface LaunchDescriptor { url: string; body: string }
export interface LaunchTicketsOptions { capture: () => LaunchIdentity; now?: () => number }
interface Ticket { identity: LaunchIdentity; expiresAt: number }
const TTL_MS = 30_000
const MAX_TICKETS = 64
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const FAILURE = 'Magpie 后台启动未完成，请检查连接设置后重试。'
function failure(): Error { return new Error(FAILURE) }
function sameIdentity(a: LaunchIdentity, b: LaunchIdentity): boolean {
  return a.revision === b.revision && a.url === b.url && a.loginKey === b.loginKey
}

/** One-use capabilities stay entirely on authenticated parent RPC; guests cannot reach DSH. */
export class LaunchTickets {
  private readonly tickets = new Map<string, Ticket>()
  private readonly capture: () => LaunchIdentity
  private readonly now: () => number
  private disposed = false
  constructor(options: LaunchTicketsOptions) {
    this.capture = options.capture
    this.now = options.now ?? Date.now
  }
  private identity(): LaunchIdentity {
    if (this.disposed) throw failure()
    try {
      const identity = this.capture()
      if (!Number.isSafeInteger(identity.revision) || identity.revision < 0) throw failure()
      const url = normalizeUrl(identity.url)
      const loginKey = validateKey(identity.loginKey, 'login')
      return { url, loginKey, revision: identity.revision }
    } catch { throw failure() }
  }
  private clock(): number {
    const now = this.now()
    if (!Number.isFinite(now)) throw failure()
    return now
  }
  issue(): LaunchIssue {
    try {
      const identity = this.identity()
      const now = this.clock()
      for (const [token, ticket] of this.tickets) {
        if (ticket.expiresAt <= now || !sameIdentity(identity, ticket.identity)) this.tickets.delete(token)
      }
      // Bound both retained secrets and outstanding attempts. Evict the oldest lease.
      while (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value!)
      const token = randomBytes(32).toString('base64url')
      const expiresAt = now + TTL_MS
      this.tickets.set(token, { identity, expiresAt })
      return { token, expiresAt }
    } catch { throw failure() }
  }
  redeem(token: string): LaunchDescriptor {
    // Consume synchronously before any validation/capture: at most one racing caller wins.
    const ticket = this.tickets.get(token)
    this.tickets.delete(token)
    try {
      if (!TOKEN_PATTERN.test(token) || !ticket) throw failure()
      const identity = this.identity()
      if (ticket.expiresAt <= this.clock() || !sameIdentity(identity, ticket.identity)) throw failure()
      return { url: `${identity.url}/_magpie/sign-in`, body: new URLSearchParams({ key: identity.loginKey, back: '/' }).toString() }
    } catch { throw failure() }
  }
  revoke(token: string): void { this.tickets.delete(token) }
  dispose(): void { this.disposed = true; this.tickets.clear() }
}
