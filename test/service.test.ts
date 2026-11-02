import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MagpieService } from '../src/service.ts'
import { ConnectionStore } from '../src/store.ts'
import { MagpieTransport } from '../src/transport.ts'

const loginKey = 'backend-secret-never-in-url'
const gatewayKey = 'sk-magpie-key-test-secret'
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }) }
interface RequestRecord { url: string; init: RequestInit; body: Record<string, unknown> }
function fixture() {
  const calls: RequestRecord[] = []
  let keyName = ''
  let modelFailure = false
  let quotaFailure = false
  let loginRedirect = '/'
  let holdModels: (() => Promise<void>) | undefined
  let failCleanup = false
  let malformedCreate = false
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    const path = new URL(url).pathname
    let body: Record<string, unknown> = {}
    if (typeof init.body === 'string' && init.headers && new Headers(init.headers).get('Content-Type') === 'application/json') body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ url, init, body })
    if (path.endsWith('/_magpie/sign-in')) {
      assert.equal(init.redirect, 'manual')
      assert.equal(init.method, 'POST')
      assert.equal(new URLSearchParams(String(init.body)).get('key'), loginKey)
      return new Response(null, { status: 303, headers: { Location: loginRedirect, 'Set-Cookie': `magpie_web_3430=${loginKey}; Path=/; HttpOnly; SameSite=Lax` } })
    }
    assert.equal(init.redirect, 'error')
    const headers = new Headers(init.headers)
    if (path.includes('/api/')) {
      assert.equal(headers.get('Cookie'), `magpie_web_3430=${loginKey}`)
      assert.equal(headers.get('Authorization'), null)
    } else {
      assert.equal(headers.get('Cookie'), null)
      assert.equal(headers.get('Authorization'), `Bearer ${gatewayKey}`)
    }
    if (path === '/api/providers') return json({ providers: [{ id: 'codex', name: 'Codex' }], gateway: { url: 'http://127.0.0.1:3425', running: true } })
    if (path === '/api/state') return json({ settings: { version: '0.1.test' } })
    if (path === '/api/caller-keys/add-key') { keyName = String(body.name); return json(malformedCreate ? {} : { keys: [{ id: 'created-id', name: keyName }], secret: gatewayKey }) }
    if (path === '/api/caller-keys') return json({ keys: [{ id: 'created-id', name: keyName }] })
    if (path === '/api/caller-keys/remove-key' && failCleanup) return json({ error: loginKey }, 500)
    if (path === '/api/caller-keys/access-key' || path === '/api/caller-keys/remove-key') return json({ keys: [] })
    if (path === '/v1/models') {
      if (holdModels) await holdModels()
      if (modelFailure) return json({ error: `raw upstream error ${loginKey} ${gatewayKey}` }, 503)
      return json({ object: 'list', data: [{ id: 'codex/gpt-5.5', owned_by: 'codex', display_name: 'GPT', context_window: 1234, reasoning_levels: ['low'] }] })
    }
    if (path === '/v1/magpie/quotas') {
      assert.equal(new URL(url).search, '?kept=1')
      if (quotaFailure) return json({}, 500)
      return json({ data: [{ provider: 'codex', user: 'private@example.com', error: '', windows: [{ name: '5h', remaining: 42 }] }, { provider: 'codex', user: 'other@example.com', windows: [{ remaining: 25 }] }] })
    }
    assert.fail(`Unexpected mock endpoint ${path}`)
  }
  return { fetcher, calls, setCleanupFailure: (value: boolean) => { failCleanup = value }, setMalformedCreate: (value: boolean) => { malformedCreate = value }, setModelFailure: (value: boolean) => { modelFailure = value }, setQuotaFailure: (value: boolean) => { quotaFailure = value }, setRedirect: (value: string) => { loginRedirect = value }, holdModels: (callback: () => Promise<void>) => { holdModels = callback } }
}
async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'magpie-connector-test-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const mock = fixture()
  let changes = 0
  const path = join(dir, 'connection.json')
  const service = new MagpieService({ storePath: path, fetch: mock.fetcher, onCatalogChanged: () => { changes++ } })
  t.after(() => service.dispose())
  return { service, mock, path, changes: () => changes }
}
const input = { url: 'http://127.0.0.1:3430', loginKey, createGatewayKey: true }

test('connect posts a fixed form, creates read-only key then enables, publishes/persists sanitized directory', async t => {
  const { service, mock, path, changes } = await setup(t)
  const status = await service.connect(input)
  assert.equal(status.connected, true)
  assert.equal(status.version, '0.1.test')
  assert.equal(status.modelCount, 1)
  assert.equal(status.groups[0]?.upstream, 'codex')
  assert.equal(changes(), 1)
  const add = mock.calls.find(call => call.url.endsWith('/add-key'))!
  assert.equal(add.body.readOnly, true)
  const enable = mock.calls.find(call => call.url.endsWith('/access-key'))!
  assert.deepEqual(enable.body, { key: 'created-id', readOnly: false })
  assert.ok(mock.calls.indexOf(add) < mock.calls.indexOf(enable))
  assert.ok(mock.calls.every(call => !call.url.includes(loginKey) && !call.url.includes(gatewayKey)))
  assert.ok(!JSON.stringify(status).includes(loginKey))
  assert.ok(!JSON.stringify(status).includes(gatewayKey))
  assert.ok(mock.calls.every(call => !call.url.includes('sharing') && !call.url.endsWith('/api/settings')))
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(stored.gatewayKey, gatewayKey)
  assert.equal(stored.gatewayUrl, 'http://127.0.0.1:3425')
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
  const group = service.catalog()[0]!
  const target = service.capture(group.route, 'codex/gpt-5.5')
  assert.equal(target.model.id, 'codex/gpt-5.5')
  assert.ok(Object.isFrozen(target) && Object.isFrozen(target.model) && Object.isFrozen(target.model.efforts))
})
test('explicit consent is required and errors never echo upstream secrets', async t => {
  const { service, mock } = await setup(t)
  await assert.rejects(service.connect({ ...input, createGatewayKey: false }), /explicitly allow/)
  assert.equal(mock.calls.filter(call => call.url.endsWith('/add-key')).length, 0)
  mock.setModelFailure(true)
  await assert.rejects(service.connect(input), /HTTP 503/)
  assert.deepEqual(mock.calls.find(call => call.url.endsWith('/remove-key'))?.body, { key: 'created-id' })
  assert.ok(!JSON.stringify(service.status()).includes(loginKey))
  assert.ok(!JSON.stringify(service.status()).includes(gatewayKey))
  assert.equal(service.status().configured, false)
})
test('gateway validation failure with supplied key never deletes user keys', async t => {
  const { service, mock } = await setup(t)
  mock.setModelFailure(true)
  await assert.rejects(service.connect({ ...input, gatewayKey, createGatewayKey: false }))
  assert.equal(mock.calls.filter(call => call.url.endsWith('/remove-key')).length, 0)
})
test('same URL retains blank saved secrets; changed management/gateway URL never reuses them', async t => {
  const { service, mock } = await setup(t)
  await service.connect(input)
  await service.connect({ ...input, loginKey: '', createGatewayKey: false })
  assert.equal(mock.calls.filter(call => call.url.endsWith('/add-key')).length, 1)
  await assert.rejects(service.connect({ ...input, url: 'https://other.test', loginKey: '', createGatewayKey: false }), /login key/)
  await assert.rejects(service.connect({ ...input, url: 'https://other.test', createGatewayKey: false }), /explicitly allow/)
  await assert.rejects(service.connect({ ...input, gatewayUrl: 'https://other.test', createGatewayKey: false }), /explicitly allow/)
  assert.equal(service.status().url, input.url)
})
test('refresh coalesces and retains cached catalog on failure', async t => {
  const { service, mock, path } = await setup(t)
  await service.connect(input)
  const before = await readFile(path, 'utf8')
  mock.setModelFailure(true)
  const first = service.refresh()
  const second = service.refresh()
  assert.equal(first, second)
  const status = await first
  assert.equal(status.modelCount, 1)
  assert.equal(status.stale, true)
  assert.equal(status.connected, false)
  assert.equal(await readFile(path, 'utf8'), before)
})
test('initialize missing file is idle; failed saved connection retains last good catalog and bytes', async t => {
  const { service, mock, path } = await setup(t)
  await service.initialize()
  assert.equal(mock.calls.length, 0)
  await service.connect(input)
  const before = await readFile(path, 'utf8')
  mock.setModelFailure(true)
  const restored = new MagpieService({ storePath: path, fetch: mock.fetcher })
  t.after(() => restored.dispose())
  await restored.initialize()
  assert.equal(restored.status().configured, true)
  assert.equal(restored.status().stale, true)
  assert.equal(restored.catalog().length, 1)
  assert.equal(await readFile(path, 'utf8'), before)
})
test('corrupt stored file is never overwritten by initialize or reconnect', async t => {
  const { service, path, mock } = await setup(t)
  await writeFile(path, '{broken original')
  await service.initialize()
  assert.equal(service.status().configured, false)
  assert.equal(service.status().stale, true)
  await assert.rejects(service.connect(input), /original file/)
  assert.equal(await readFile(path, 'utf8'), '{broken original')
  assert.ok(mock.calls.some(call => call.url.endsWith('/remove-key')))
})
test('disconnect only removes local file and retains immutable previously captured generation', async t => {
  const { service, path, mock } = await setup(t)
  await service.connect(input)
  const group = service.catalog()[0]!
  const target = service.capture(group.route, group.models[0]!.id)
  await service.disconnect()
  assert.equal(service.status().configured, false)
  assert.deepEqual(service.catalog(), [])
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  assert.equal(target.gatewayKey, gatewayKey)
  assert.equal(mock.calls.filter(call => call.url.endsWith('/remove-key')).length, 0)
})
test('quota snapshots cache aggregate summaries without exposing account data', async t => {
  const { service, mock } = await setup(t)
  await service.connect(input)
  const quota = await service.quotas()
  assert.equal(quota.summaries.length, 1)
  assert.match(quota.summaries[0]!.text, /25%/)
  assert.equal(quota.providers?.[0]?.provider, 'codex')
  assert.deepEqual(quota.providers?.[0]?.accounts.map(account => account.label), ['账号1', '账号2'])
  assert.equal(quota.providers?.[0]?.accounts[0]?.windows[0]?.remaining, 42)
  assert.equal(quota.providers?.[0]?.accounts[0]?.stale, true)
  assert.ok(!JSON.stringify(quota).includes('@example.com'))
  assert.ok(!JSON.stringify(quota).includes(loginKey))
  quota.providers![0]!.accounts[0]!.windows[0]!.remaining = 0
  const cached = await service.quotas()
  assert.equal(cached.providers?.[0]?.accounts[0]?.windows[0]?.remaining, 42)
  assert.equal(mock.calls.filter(call => call.url.includes('/v1/magpie/quotas')).length, 1)
})
test('login rejects cross-origin redirect without sending a second request', async () => {
  const mock = fixture()
  mock.setRedirect('https://evil.test/steal')
  const transport = new MagpieTransport(mock.fetcher)
  await assert.rejects(transport.login(input.url, loginKey), /unsafe redirect/)
  assert.equal(mock.calls.length, 1)
})
test('management redirects are configured as errors; transport redacts thrown fetch causes', async () => {
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(init?.redirect, 'error')
    throw new Error(`redirect https://evil.test/?key=${loginKey}`)
  }
  const transport = new MagpieTransport(fetcher)
  await assert.rejects(transport.management(input.url, 'cookie', '/api/providers'), error => error instanceof Error && !error.message.includes(loginKey) && !error.message.includes('evil.test'))
})
test('transport forwards cancellation and a bounded timeout signal', async () => {
  const controller = new AbortController()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const transport = new MagpieTransport(async (_url, init) => {
    entered()
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(init?.signal?.reason)
      if (init?.signal?.aborted) abort()
      else init?.signal?.addEventListener('abort', abort, { once: true })
    })
  }, 500)
  const pending = transport.login(input.url, loginKey, controller.signal)
  await started
  controller.abort()
  await assert.rejects(pending, /cancelled/)
})
test('malformed key creation response recovers unique created id for cleanup', async t => {
  const { service, mock } = await setup(t)
  mock.setMalformedCreate(true)
  await assert.rejects(service.connect(input), /usable dedicated gateway key/)
  assert.ok(mock.calls.some(call => call.url.endsWith('/api/caller-keys')))
  assert.deepEqual(mock.calls.find(call => call.url.endsWith('/remove-key'))?.body, { key: 'created-id' })
})
test('cleanup failure is explicitly reported without upstream payloads', async t => {
  const { service, mock } = await setup(t)
  mock.setModelFailure(true)
  mock.setCleanupFailure(true)
  await assert.rejects(service.connect(input), /could not be revoked/)
  assert.match(service.status().error!, /could not be revoked/)
  assert.ok(!service.status().error!.includes(loginKey))
})
test('aborted connect never creates a key or replaces persisted connection', async t => {
  const { service, mock } = await setup(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(service.connect(input, controller.signal), /cancelled/)
  assert.equal(mock.calls.length, 0)
  assert.equal(service.status().configured, false)
})
test('disposal cancels in-flight quota requests', async t => {
  const { service, mock, path } = await setup(t)
  await service.connect(input)
  const stored = await new ConnectionStore(path).load()
  assert.ok(stored)
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const fetcher: typeof fetch = async (url, init) => {
    if (!String(url).includes('/v1/magpie/quotas')) return mock.fetcher(url, init)
    entered()
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
  }
  const instance = new MagpieService({ storePath: path, fetch: fetcher })
  await instance.initialize()
  const pending = instance.quotas()
  await started
  instance.dispose()
  await pending
})
test('ConnectionStore validates schema without discarding unknown unreadable/invalid data', async t => {
  const { path } = await setup(t)
  const store = new ConnectionStore(path)
  assert.equal(await store.load(), undefined)
  await writeFile(path, JSON.stringify({ schemaVersion: 99 }))
  await assert.rejects(store.load(), /original file/)
  assert.equal(await readFile(path, 'utf8'), '{"schemaVersion":99}')
})

test('connect commits the saved generation even if caller aborts immediately after persistence', { concurrency: false }, async t => {
  const { service, mock, path, changes } = await setup(t)
  const controller = new AbortController()
  const realSave = ConnectionStore.prototype.save
  const save = t.mock.method(ConnectionStore.prototype, 'save', async function (this: ConnectionStore, connection: Parameters<ConnectionStore['save']>[0]) {
    await realSave.call(this, connection)
    controller.abort()
  })

  const status = await service.connect(input, controller.signal)
  assert.equal(controller.signal.aborted, true)
  assert.equal(save.mock.callCount(), 1)
  assert.equal(status.configured, true)
  assert.equal(status.connected, true)
  assert.equal(status.stale, false)
  assert.equal(status.error, null)
  assert.equal(changes(), 1)
  const stored = await new ConnectionStore(path).load()
  assert.ok(stored)
  assert.equal(status.syncedAt, stored.syncedAt)
  assert.equal(status.gatewayUrl, stored.gatewayUrl)
  assert.deepEqual(service.catalog(), stored.catalog)
  const group = stored.catalog[0]!
  const target = service.capture(group.route, group.models[0]!.id)
  assert.equal(target.gatewayKey, stored.gatewayKey)
  assert.equal(target.gatewayUrl, stored.gatewayUrl)
  assert.deepEqual(target.model, group.models[0])
  assert.equal(mock.calls.filter(call => call.url.endsWith('/remove-key')).length, 0)
})

test('refresh commits a changed directory even if caller aborts immediately after persistence', { concurrency: false }, async t => {
  const { service, mock, path } = await setup(t)
  await service.connect(input)
  let refreshed = false
  let changes = 0
  const fetcher: typeof fetch = async (url, init) => {
    if (refreshed && new URL(String(url)).pathname === '/v1/models') {
      return json({ object: 'list', data: [{ id: 'codex/refreshed-model', owned_by: 'codex', display_name: 'Refreshed model', context_window: 8192, reasoning_levels: ['high'] }] })
    }
    return mock.fetcher(url, init)
  }
  const instance = new MagpieService({ storePath: path, fetch: fetcher, onCatalogChanged: () => { changes++ } })
  t.after(() => instance.dispose())
  await instance.initialize()
  assert.equal(instance.catalog()[0]?.models[0]?.id, 'codex/gpt-5.5')
  const beforeChanges = changes
  refreshed = true
  const controller = new AbortController()
  const realSave = ConnectionStore.prototype.save
  const save = t.mock.method(ConnectionStore.prototype, 'save', async function (this: ConnectionStore, connection: Parameters<ConnectionStore['save']>[0]) {
    await realSave.call(this, connection)
    controller.abort()
  })

  const status = await instance.refresh(controller.signal)
  assert.equal(controller.signal.aborted, true)
  assert.equal(save.mock.callCount(), 1)
  assert.equal(status.connected, true)
  assert.equal(status.stale, false)
  assert.equal(status.error, null)
  assert.equal(changes, beforeChanges + 1)
  const stored = await new ConnectionStore(path).load()
  assert.ok(stored)
  assert.equal(status.syncedAt, stored.syncedAt)
  assert.deepEqual(instance.catalog(), stored.catalog)
  const group = stored.catalog[0]!
  assert.equal(group.models[0]?.id, 'codex/refreshed-model')
  assert.deepEqual(instance.capture(group.route, 'codex/refreshed-model').model, group.models[0])
  assert.throws(() => instance.capture(group.route, 'codex/gpt-5.5'), /no longer available/)
})
