import type { StoredConnection } from './contracts.ts'

/** Errors safe to return over RPC. Never expose upstream bodies, URLs or fetch causes. */
export class ConnectorError extends Error {
  constructor(message: string) { super(message); this.name = 'ConnectorError' }
}
export function safeError(error: unknown): string {
  if (error instanceof ConnectorError) return error.message
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return 'Magpie request was cancelled or timed out.'
  return 'Magpie request failed. Check the connection and try again.'
}

/** Credentials must never enter address bars, query strings or an accidental redirect. */
export function normalizeUrl(raw: string, gateway = false): string {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new ConnectorError('Enter an absolute HTTP or HTTPS Magpie URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new ConnectorError('Magpie URLs must use HTTP(S), without credentials, query parameters or fragments.')
  }
  // Dot segments are normalized by URL; encoded separators would make joining ambiguous.
  if (/%(?:2f|5c|00)/i.test(url.pathname)) throw new ConnectorError('Magpie URL contains an unsupported path.')
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') throw new ConnectorError('Use a reachable Magpie host, not a wildcard listen address.')
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  if (gateway) url.pathname = url.pathname.replace(/\/v1$/i, '') || '/'
  return url.toString().replace(/\/$/, '')
}
export function isLoopback(raw: string): boolean {
  const hostname = new URL(raw).hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}
export function endpoint(base: string, path: string): string {
  // All callers supply fixed protocol paths, not user-controlled URLs.
  if (!path.startsWith('/') || path.startsWith('//')) throw new ConnectorError('Invalid Magpie request path.')
  return `${base}${path}`
}
export function validateKey(raw: string, label: 'login' | 'gateway'): string {
  const key = raw.trim()
  if (!key || key.length > 1024 || /[\r\n\x00-\x1f\x7f]/.test(key) || (label === 'gateway' && /[^\x21-\x7e]/.test(key))) {
    throw new ConnectorError(label === 'login' ? 'Enter a valid Magpie backend login key.' : 'Enter a valid Magpie gateway key.')
  }
  return key
}
export type JsonObject = Record<string, unknown>
export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

const MAX_JSON_BYTES = 8 * 1024 * 1024
export class MagpieTransport {
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number
  constructor(fetcher: typeof fetch = fetch, timeoutMs = 15_000) { this.fetcher = fetcher; this.timeoutMs = timeoutMs }

  private signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }
  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    try {
      signal?.throwIfAborted()
      return await this.fetcher(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer', signal: this.signal(signal) })
    } catch (error) {
      if (signal?.aborted) throw new ConnectorError('Magpie request was cancelled.')
      if (error instanceof Error && error.name === 'TimeoutError') throw new ConnectorError('Magpie request timed out.')
      throw new ConnectorError('Cannot reach Magpie. Check the URL, network and redirect configuration.')
    }
  }
  private async json(response: Response): Promise<unknown> {
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if (response.status === 401) throw new ConnectorError('Magpie rejected the credential. Sign in again or check the gateway key.')
      if (response.status === 403) throw new ConnectorError('Magpie refused access. Check gateway permissions and sharing in Magpie; this plugin does not change sharing.')
      throw new ConnectorError(`Magpie returned HTTP ${response.status}.`)
    }
    const type = response.headers.get('content-type') ?? ''
    if (!type.includes('application/json')) {
      await response.body?.cancel().catch(() => {})
      throw new ConnectorError('Magpie returned an unexpected response instead of JSON.')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new ConnectorError('Magpie returned an empty JSON response.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.byteLength
        if (size > MAX_JSON_BYTES) { await reader.cancel(); throw new ConnectorError('Magpie response exceeds the connector limit.') }
        chunks.push(result.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown
    } catch (error) {
      if (error instanceof ConnectorError) throw error
      throw new ConnectorError('Magpie returned invalid JSON or the response was interrupted.')
    } finally { reader.releaseLock() }
  }

  async login(url: string, loginKey: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request(endpoint(url, '/_magpie/sign-in'), {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: loginKey, back: '/' }).toString(),
    }, signal)
    try {
      if (response.status !== 303) throw new ConnectorError('Magpie backend login failed. Check the backend URL and login key.')
      const location = response.headers.get('location')
      if (!location || new URL(location, url).origin !== new URL(url).origin) throw new ConnectorError('Magpie login attempted an unsafe redirect.')
      const cookies = response.headers.getSetCookie()
      const accepted: string[] = []
      for (const header of cookies) {
        const first = header.split(';', 1)[0] ?? ''
        if (!/^magpie_web_\d+=[A-Za-z0-9._~-]+$/.test(first)) continue
        const domain = /;\s*domain=([^;]+)/i.exec(header)?.[1]?.replace(/^\./, '').toLowerCase()
        if (domain && domain !== new URL(url).hostname.toLowerCase()) continue
        accepted.push(first)
      }
      if (!accepted.length) throw new ConnectorError('Magpie did not establish a backend login session.')
      return accepted.join('; ')
    } catch (error) {
      if (error instanceof ConnectorError) throw error
      throw new ConnectorError('Magpie login returned an invalid redirect or session.')
    } finally { await response.body?.cancel().catch(() => {}) }
  }
  async management(url: string, cookie: string, path: string, body?: JsonObject, signal?: AbortSignal): Promise<unknown> {
    return this.json(await this.request(endpoint(url, path), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Accept: 'application/json', Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, signal))
  }
  async gateway(connection: Pick<StoredConnection, 'gatewayUrl' | 'gatewayKey'>, path: string, signal?: AbortSignal): Promise<unknown> {
    return this.json(await this.request(endpoint(connection.gatewayUrl, path), {
      redirect: 'error', headers: { Accept: 'application/json', Authorization: `Bearer ${connection.gatewayKey}` },
    }, signal))
  }
}
