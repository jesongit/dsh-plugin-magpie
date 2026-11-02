import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpeedStore } from '../src/speed-store.ts'
import type { MagpieAdapterService } from '../src/adapter.ts'
import { MagpieAdapter } from '../src/adapter.ts'
import type { CatalogGroup } from '../src/contracts.ts'

test('speed store remembers session tier, persists the default, and survives reload', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'magpie-speed-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const path = join(dir, 'speed.json')
  const fresh = new SpeedStore(path)
  assert.equal(fresh.tier('session-a'), 'standard')
  fresh.set('session-a', 'fast')
  assert.equal(fresh.tier('session-a'), 'fast')
  assert.equal(fresh.tier('session-b'), 'fast')
  const reloaded = new SpeedStore(path)
  assert.equal(reloaded.tier('session-c'), 'fast')
  reloaded.set('session-d', 'standard')
  assert.equal(new SpeedStore(path).tier('session-e'), 'standard')
  await writeFile(join(dir, 'speed.json'), '{broken', { encoding: 'utf8' })
  assert.equal(new SpeedStore(path).tier('session-f'), 'standard')
})

const group: CatalogGroup = { route: 'magpie-codex-x', upstream: 'codex', name: 'Codex', models: [
  { id: 'codex/gpt', name: 'GPT', efforts: ['low', 'high'], fastTier: true },
  { id: 'codex/slow', name: 'Slow', efforts: ['low', 'high'] },
] }
function adapter(tier: 'standard' | 'fast'): { adapter: MagpieAdapter; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  const service: MagpieAdapterService = {
    catalog: () => [group],
    capture: () => ({ gatewayUrl: 'https://gateway.test', gatewayKey: 'test-only', provider: 'magpie-codex-x', model: structuredClone(group.models[0]!) }),
    sessionTier: () => tier,
  }
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return { adapter: new MagpieAdapter(service, { fetch: fetcher }), bodies }
}
const generate = { provider: 'magpie-codex-x', model: 'codex/gpt', sessionId: 'session-1', messages: [], tools: [], toolHistory: [], signal: undefined } as never

test('fast tier injects priority only for models advertising it; standard never sends the field', async () => {
  const fast = adapter('fast')
  for await (const _chunk of fast.adapter.stream(generate)) void _chunk
  const slow = structuredClone(group.models[1]!)
  slow.id = 'codex/slow'
  assert.equal(fast.bodies[0]!.service_tier, 'priority')
  const standard = adapter('standard')
  for await (const _chunk of standard.adapter.stream(generate)) void _chunk
  assert.equal('service_tier' in standard.bodies[0]!, false)
  void slow
})
