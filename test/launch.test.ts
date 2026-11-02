import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LaunchTickets } from '../src/launch.ts'
import type { LaunchIdentity } from '../src/launch.ts'
import { MagpieService } from '../src/service.ts'
import { dispatch, ENDPOINTS, registerRpc } from '../src/rpc.ts'

const identity: LaunchIdentity = { url: 'https://magpie.test/base', loginKey: 'login-secret & + = 你好', revision: 1 }
const tokenShape = /^[A-Za-z0-9_-]{43}$/
const signal = () => new AbortController().signal

test('launch tickets use 32-byte crypto capabilities and only return a POST descriptor on redemption', () => {
  const tickets = new LaunchTickets({ capture: () => identity, now: () => 1000 })
  const first = tickets.issue()
  const second = tickets.issue()
  assert.match(first.token, tokenShape)
  assert.equal(Buffer.from(first.token, 'base64url').byteLength, 32)
  assert.notEqual(first.token, second.token)
  assert.equal(first.expiresAt, 31_000)
  assert.deepEqual(Object.keys(first).sort(), ['expiresAt', 'token'])
  const descriptor = tickets.redeem(first.token)
  assert.equal(descriptor.url, 'https://magpie.test/base/_magpie/sign-in')
  assert.equal(new URL(descriptor.url).search, '')
  assert.equal(new URL(descriptor.url).hash, '')
  assert.equal(new URLSearchParams(descriptor.body).get('key'), identity.loginKey)
  assert.equal(new URLSearchParams(descriptor.body).get('back'), '/')
  assert.deepEqual([...new URLSearchParams(descriptor.body).keys()].sort(), ['back', 'key'])
  assert.throws(() => tickets.redeem(first.token), /后台启动未完成/)
  tickets.dispose()
})

test('exact TTL boundary expires capabilities and bounds active tickets by evicting oldest', () => {
  let now = 1
  const tickets = new LaunchTickets({ capture: () => identity, now: () => now })
  const expires = tickets.issue()
  now = expires.expiresAt
  assert.throws(() => tickets.redeem(expires.token), /后台启动未完成/)
  const tokens = Array.from({ length: 65 }, () => tickets.issue().token)
  assert.throws(() => tickets.redeem(tokens[0]!), /后台启动未完成/)
  assert.ok(tickets.redeem(tokens[1]!).body)
  assert.ok(tickets.redeem(tokens.at(-1)!).body)
  tickets.dispose()
})

test('one racing redemption wins; revoke is idempotent; disposal rejects every future operation', async () => {
  const tickets = new LaunchTickets({ capture: () => identity })
  const { token } = tickets.issue()
  const raced = await Promise.allSettled([0, 1].map(() => Promise.resolve().then(() => tickets.redeem(token))))
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(raced.filter(result => result.status === 'rejected').length, 1)
  const revoked = tickets.issue().token
  tickets.revoke(revoked)
  tickets.revoke(revoked)
  assert.throws(() => tickets.redeem(revoked), /后台启动未完成/)
  const disposed = tickets.issue().token
  tickets.dispose()
  tickets.dispose()
  assert.throws(() => tickets.issue(), /后台启动未完成/)
  assert.throws(() => tickets.redeem(disposed), /后台启动未完成/)
  assert.doesNotThrow(() => tickets.revoke(disposed))
})

test('revision, URL and key changes invalidate captured identity; failed capture is generic and consumes first', () => {
  let current = { ...identity }
  let captureFails = false
  const tickets = new LaunchTickets({ capture: () => { if (captureFails) throw new Error(`raw ${identity.loginKey}`); return current } })
  for (const replacement of [{ ...identity, revision: 2 }, { ...identity, url: 'https://other.test' }, { ...identity, loginKey: 'new-secret' }]) {
    current = { ...identity }
    const { token } = tickets.issue()
    current = replacement
    assert.throws(() => tickets.redeem(token), error => {
      assert.equal((error as Error).message.includes(identity.loginKey), false)
      return /后台启动未完成/.test((error as Error).message)
    })
  }
  current = { ...identity }
  const consumed = tickets.issue().token
  captureFails = true
  assert.throws(() => tickets.redeem(consumed), /后台启动未完成/)
  assert.throws(() => tickets.issue(), /后台启动未完成/)
  captureFails = false
  assert.throws(() => tickets.redeem(consumed), /后台启动未完成/)
  tickets.dispose()
})

test('unsafe captured launch URL and invalid revisions cannot issue capabilities', () => {
  for (const url of ['javascript:alert(1)', 'https://magpie.test/?k=secret', 'https://u:p@magpie.test/', 'https://magpie.test/#secret']) {
    assert.throws(() => new LaunchTickets({ capture: () => ({ ...identity, url }) }).issue(), /后台启动未完成/)
  }
  for (const revision of [-1, Infinity, NaN, 1.5]) {
    assert.throws(() => new LaunchTickets({ capture: () => ({ ...identity, revision }) }).issue(), /后台启动未完成/)
  }
})

function json(value: unknown): Response { return Response.json(value) }
async function serviceFixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'magpie-launch-test-'))
  let rejectModels = false
  const service = new MagpieService({ storePath: join(dir, 'connection.json'), fetch: async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path === '/_magpie/sign-in') return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': 'magpie_web_3430=login-secret; Path=/; HttpOnly; SameSite=Lax' } })
    if (path === '/api/providers') return json({ providers: [], gateway: { url: 'http://127.0.0.1:3425' } })
    if (path === '/api/state') return json({ settings: { version: 'test' } })
    if (path === '/v1/models') return rejectModels ? new Response(null, { status: 503 }) : json({ data: [{ id: 'codex/test', owned_by: 'codex' }] })
    assert.fail(`Unexpected fixture path: ${path} ${init?.method}`)
  } })
  t.after(async () => { service.dispose(); await rm(dir, { recursive: true, force: true }) })
  await service.initialize()
  const input = { url: 'http://127.0.0.1:3430', loginKey: 'login-secret', gatewayKey: 'gateway-secret', createGatewayKey: false }
  return { service, input, failModels: (fail: boolean) => { rejectModels = fail } }
}

test('service connection revision changes only on committed connect/disconnect; refresh preserves issued launch', async t => {
  const { service, input, failModels } = await serviceFixture(t)
  assert.throws(() => service.launchIdentity(), /not configured/)
  await service.connect(input)
  const committed = service.launchIdentity()
  assert.equal(committed.revision, 1)
  committed.loginKey = 'detached-only'
  assert.equal(service.launchIdentity().loginKey, 'login-secret')
  const tickets = new LaunchTickets({ capture: () => service.launchIdentity() })
  const survivesRefresh = tickets.issue().token
  await service.refresh()
  assert.equal(service.launchIdentity().revision, 1)
  assert.equal(new URLSearchParams(tickets.redeem(survivesRefresh).body).get('key'), 'login-secret')
  const survivesFailures = tickets.issue().token
  failModels(true)
  await service.refresh()
  await assert.rejects(service.connect(input))
  assert.equal(service.launchIdentity().revision, 1)
  assert.ok(tickets.redeem(survivesFailures))
  failModels(false)
  const replaced = tickets.issue().token
  await service.connect(input)
  assert.equal(service.launchIdentity().revision, 2)
  assert.throws(() => tickets.redeem(replaced), /后台启动未完成/)
  const disconnected = tickets.issue().token
  await service.disconnect()
  assert.throws(() => tickets.redeem(disconnected), /后台启动未完成/)
  await service.connect(input)
  assert.equal(service.launchIdentity().revision, 4)
  const disposed = tickets.issue().token
  service.dispose()
  assert.throws(() => tickets.redeem(disposed), /后台启动未完成/)
  tickets.dispose()
})

interface RpcRegistration { path: string; methods: string[]; requestBody: string; fetch(request: Request): Promise<Response> }
function rpcFixture(service: MagpieService) {
  const routes = new Map<string, RpcRegistration>()
  const cleanups: (() => void)[] = []
  const connection = { fetch: { register: (registration: RpcRegistration) => {
    routes.set(registration.path, registration)
    return () => { routes.delete(registration.path) }
  } } }
  const ctx = { get: () => connection, inject: (_keys: unknown, callback: (ctx: unknown) => void) => callback(ctx), effect: (execute: () => (() => void)) => {
    const cleanup = execute(); cleanups.push(cleanup); return cleanup
  } }
  registerRpc(ctx as unknown as Context, service)
  return { routes, dispose: () => { for (const cleanup of cleanups.reverse()) cleanup() } }
}
function request(endpoint: string, payload: unknown = {}): Request {
  return new Request(`http://dsh.test/api/magpie.${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: `magpie.${endpoint}`, payload }) })
}

test('launch RPC stays on existing exact owner Fetch registrations with no-store and generic failures', async t => {
  const { service, input } = await serviceFixture(t)
  await service.connect(input)
  const rpc = rpcFixture(service)
  t.after(rpc.dispose)
  assert.equal(rpc.routes.size, ENDPOINTS.length)
  for (const route of rpc.routes.values()) {
    assert.match(route.path, /^\/api\/magpie\./)
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
  }
  const issueRoute = rpc.routes.get('/api/magpie.launch.issue')!
  const redeemRoute = rpc.routes.get('/api/magpie.launch.redeem')!
  const revokeRoute = rpc.routes.get('/api/magpie.launch.revoke')!
  const issued = await issueRoute.fetch(request('launch.issue'))
  assert.equal(issued.headers.get('cache-control'), 'no-store')
  const envelope = await issued.json() as { result: { ok: boolean; value: { token: string } } }
  assert.equal(envelope.result.ok, true)
  const token = envelope.result.value.token
  const redeemed = await redeemRoute.fetch(request('launch.redeem', { token }))
  assert.equal(redeemed.headers.get('cache-control'), 'no-store')
  const descriptor = await redeemed.json() as { result: { value: { url: string; body: string } } }
  assert.equal(new URLSearchParams(descriptor.result.value.body).get('key'), input.loginKey)
  assert.equal(JSON.stringify(descriptor).includes(input.gatewayKey), false)
  const denied = await redeemRoute.fetch(request('launch.redeem', { token }))
  const deniedText = await denied.text()
  assert.equal(deniedText.includes(input.loginKey), false)
  assert.equal(deniedText.includes(token), false)
  assert.equal(JSON.parse(deniedText).result.ok, false)
  const revoked = await issueRoute.fetch(request('launch.issue')).then(response => response.json()) as { result: { value: { token: string } } }
  for (let index = 0; index < 2; index++) assert.equal((await revokeRoute.fetch(request('launch.revoke', revoked.result.value)).then(response => response.json())).result.ok, true)
  assert.equal((await redeemRoute.fetch(request('launch.redeem', revoked.result.value)).then(response => response.json())).result.ok, false)
  for (const invalid of [null, {}, { token: true }, { token: 'too-short' }]) {
    const response = await redeemRoute.fetch(request('launch.redeem', invalid))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await response.json()).result.ok, false)
  }
  for (const [requestValue, status] of [
    [new Request('http://dsh.test/', { method: 'POST', body: '{}' }), 415],
    [new Request('http://dsh.test/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' }), 400],
    [request('status'), 400],
  ] as const) {
    const response = await issueRoute.fetch(requestValue)
    assert.equal(response.status, status)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  const disposeToken = await issueRoute.fetch(request('launch.issue')).then(response => response.json()) as { result: { value: { token: string } } }
  rpc.dispose()
  // Retained handler cannot redeem a disposed lifecycle's secret even after route removal.
  assert.equal((await redeemRoute.fetch(request('launch.redeem', disposeToken.result.value)).then(response => response.json())).result.ok, false)
})

test('dispatch rejects pre-cancelled launch before issuing and missing ticket ownership fails', async t => {
  const { service } = await serviceFixture(t)
  const controller = new AbortController()
  controller.abort()
  const tickets = new LaunchTickets({ capture: () => identity })
  await assert.rejects(dispatch(service, 'launch.issue', {}, controller.signal, tickets))
  await assert.rejects(dispatch(service, 'launch.issue', {}, signal()))
  tickets.dispose()
})
