import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { ConnectInput } from './contracts.ts'
import type { MagpieService } from './service.ts'
import type { SpeedStore } from './speed-store.ts'
import { LaunchTickets } from './launch.ts'
import { ConnectorError } from './transport.ts'

export interface SpeedView { tier: 'standard' | 'fast'; visible: boolean }
function sessionId(payload: unknown): string {
  const value = (payload as Record<string, unknown> | null)?.sessionId
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error('Invalid speed request')
  return value
}
function speedTier(payload: unknown): 'standard' | 'fast' {
  const value = (payload as Record<string, unknown> | null)?.tier
  if (value !== 'standard' && value !== 'fast') throw new Error('Invalid speed request')
  return value
}

export const ENDPOINTS = ['status', 'connect', 'refresh', 'disconnect', 'quotas', 'speed', 'setSpeed', 'launch.issue', 'launch.redeem', 'launch.revoke'] as const
export type Endpoint = typeof ENDPOINTS[number]

export function readConnectInput(value: unknown): ConnectInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('连接参数必须是对象。')
  const v = value as Record<string, unknown>
  if (typeof v.url !== 'string' || typeof v.loginKey !== 'string' || typeof v.createGatewayKey !== 'boolean') throw new Error('请填写后台 URL、登录密钥并确认网关密钥选项。')
  for (const key of ['gatewayUrl', 'gatewayKey']) if (v[key] !== undefined && typeof v[key] !== 'string') throw new Error('高级连接参数格式不正确。')
  if (v.url.length > 4096 || v.loginKey.length > 16384 || (typeof v.gatewayKey === 'string' && v.gatewayKey.length > 16384)) throw new Error('连接参数过长。')
  return { url: v.url, loginKey: v.loginKey, createGatewayKey: v.createGatewayKey,
    ...(typeof v.gatewayUrl === 'string' && v.gatewayUrl.trim() ? { gatewayUrl: v.gatewayUrl.trim() } : {}),
    ...(typeof v.gatewayKey === 'string' && v.gatewayKey.trim() ? { gatewayKey: v.gatewayKey.trim() } : {}) }
}

function launchToken(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid launch request')
  const token = (payload as Record<string, unknown>).token
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid launch request')
  return token
}

export async function dispatch(service: MagpieService, endpoint: Endpoint, payload: unknown, signal: AbortSignal, tickets?: LaunchTickets, speeds?: SpeedStore): Promise<unknown> {
  signal.throwIfAborted()
  switch (endpoint) {
    case 'status': return service.status()
    case 'connect': return service.connect(readConnectInput(payload), signal)
    case 'refresh': return service.refresh(signal)
    case 'disconnect': return service.disconnect()
    case 'quotas': return service.quotas(signal)
    case 'speed': {
      if (!speeds) throw new Error('Speed unavailable')
      const session = sessionId(payload)
      const provider = typeof (payload as Record<string, unknown>).provider === 'string' ? String((payload as Record<string, unknown>).provider) : ''
      const model = typeof (payload as Record<string, unknown>).model === 'string' ? String((payload as Record<string, unknown>).model) : ''
      const visible = provider.length > 0 && model.length > 0 && service.supportsFastTier(provider, model)
      return { tier: speeds.tier(session), visible, fastTier: visible }
    }
    case 'setSpeed': {
      if (!speeds) throw new Error('Speed unavailable')
      speeds.set(sessionId(payload), speedTier(payload))
      return {}
    }
    case 'launch.issue': {
      if (!tickets) throw new Error('Launch unavailable')
      return tickets.issue()
    }
    case 'launch.redeem': {
      if (!tickets) throw new Error('Launch unavailable')
      return tickets.redeem(launchToken(payload))
    }
    case 'launch.revoke': {
      if (!tickets) throw new Error('Launch unavailable')
      tickets.revoke(launchToken(payload))
      return {}
    }
  }
}

/** Exact Fetch registrations inherit DSH's owner authentication and origin fence. */
export function registerRpc(ctx: Context, service: MagpieService, speeds?: SpeedStore): void {
  ctx.inject(['connection'], ctx => {
    const connection = ctx.get('connection') as HostConnectionHandle
    const tickets = new LaunchTickets({ capture: () => service.launchIdentity() })
    ctx.effect(() => () => tickets.dispose(), 'magpie launch tickets')
    for (const endpoint of ENDPOINTS) ctx.effect(() => connection.fetch.register({
      path: `/api/magpie.${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return new Response(null, { status: 415, headers: { 'Cache-Control': 'no-store' } })
        let body: Record<string, unknown>
        try { body = await request.json() as Record<string, unknown> } catch { return new Response(null, { status: 400, headers: { 'Cache-Control': 'no-store' } }) }
        if (!body || body.type !== 'client-request' || typeof body.rpcId !== 'string' || body.method !== `magpie.${endpoint}`) return new Response(null, { status: 400, headers: { 'Cache-Control': 'no-store' } })
        let result: unknown
        try { result = { ok: true, value: await dispatch(service, endpoint, body.payload, request.signal, tickets, speeds) } }
        catch (error) {
          // Never echo upstream request errors, typed secrets, URLs or cookie contents.
          // ConnectorError is locally authored with controlled text (validation
          // messages, sanitized failures), so it is safe to relay verbatim.
          const message = error instanceof ConnectorError ? error.message
            : endpoint.startsWith('launch.') ? 'Magpie 后台启动未完成，请检查连接设置后重试。'
            : service.status().error ?? 'Magpie 操作未完成，请检查连接设置后重试。'
          result = { ok: false, error: { code: 'magpie/operation-failed', message, details: {} } }
        }
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result }, { headers: { 'Cache-Control': 'no-store' } })
      }
    }), `magpie ${endpoint} RPC`)
  })
}
