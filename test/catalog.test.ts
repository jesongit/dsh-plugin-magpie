import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCatalog, providerNames, providerRoute } from '../src/catalog.ts'
import { discoverGateway } from '../src/service.ts'
import { normalizeUrl } from '../src/transport.ts'

test('actual Magpie fields group by owned_by and preserve full upstream ids', () => {
  const names = providerNames({ providers: [{ id: 'codex', name: 'Codex' }, { id: 'workbuddy', name: 'WorkBuddy' }] })
  const groups = parseCatalog({ object: 'list', data: [
    { id: 'codex/gpt-5.5', owned_by: 'codex', display_name: 'GPT 5.5', context_window: 200000, max_output_tokens: 20000, reasoning_levels: ['low', 'high'], modalities: { input: ['text', 'image'], output: ['text'] } },
    { id: 'workbuddy/claude', owned_by: 'workbuddy', supported_reasoning_levels: [{ effort: 'medium' }] },
    { id: 'auto/claude', owned_by: 'auto', display_name: 'Auto' },
    { id: 'group/my-route', owned_by: 'codex', display_name: 'Custom route' },
    { id: 'codex/image', owned_by: 'codex', kind: 'image' },
    { id: 'codex/gpt-5.5', owned_by: 'codex' },
  ] }, names)
  assert.equal(groups.length, 3)
  assert.equal(groups[0]?.name, 'Magpie · Codex')
  assert.deepEqual(groups[0]?.models[0], { id: 'codex/gpt-5.5', name: 'GPT 5.5', contextWindow: 200000, maxTokens: 20000, efforts: ['low', 'high'], inputModalities: ['text', 'image'] })
  assert.deepEqual(groups[1]?.models[0]?.efforts, ['medium'])
  assert.equal(groups[2]?.upstream, 'group')
  assert.deepEqual(groups[2]?.models.map(m => m.id), ['auto/claude', 'group/my-route'])
  assert.ok(groups.every(g => /^magpie-[a-z0-9-]+$/.test(g.route)))
})
test('provider routes are deterministic and avoid slug collisions', () => {
  assert.equal(providerRoute('a/b'), providerRoute('a/b'))
  assert.notEqual(providerRoute('a/b'), providerRoute('a-b'))
  assert.notEqual(providerRoute('A'), providerRoute('a'))
})
test('directory parser distinguishes failed format from valid empty list', () => {
  assert.deepEqual(parseCatalog({ data: [] }), [])
  assert.throws(() => parseCatalog({ models: [] }), /unsupported format/)
  assert.throws(() => parseCatalog({ data: [{ id: null }] }), /no recognizable/)
})
test('URL validation rejects embedded credentials and signed-in URLs before fetch', () => {
  for (const url of ['file:///tmp/key', 'javascript:alert(1)', 'http://user:secret@localhost/', 'http://localhost/?k=secret', 'http://localhost/#secret', 'http://localhost/?foo=1', 'http://localhost/a%2fb']) assert.throws(() => normalizeUrl(url))
  assert.equal(normalizeUrl('http://localhost:3430///'), 'http://localhost:3430')
  assert.equal(normalizeUrl('https://magpie.test/prefix/v1/', true), 'https://magpie.test/prefix')
})
test('remote gateway discovery never targets server-reported loopback or unrelated host', () => {
  assert.equal(discoverGateway('https://magpie.test', { gateway: { url: 'http://127.0.0.1:3425' } }), 'https://magpie.test')
  assert.equal(discoverGateway('https://magpie.test', { gateway: { url: 'https://other.test' } }), 'https://magpie.test')
  assert.equal(discoverGateway('https://magpie.test', { gateway: { url: 'http://magpie.test:3425' } }), 'https://magpie.test')
  assert.equal(discoverGateway('http://127.0.0.1:3430', { gateway: { url: 'http://127.0.0.1:3425' } }), 'http://127.0.0.1:3425')
  assert.equal(discoverGateway('https://magpie.test', {}, 'https://gateway.test/v1'), 'https://gateway.test')
})
