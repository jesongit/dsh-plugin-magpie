import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { MagpieAdapter } from '../src/adapter.ts'
import { readConnectInput } from '../src/rpc.ts'

test('real DSH registry supports dormant connector then atomic provider changes', async () => {
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  let groups = [{ route: 'magpie-codex-test', upstream: 'codex', name: 'Magpie · Codex', models: [{ id: 'codex/model', name: 'Model', efforts: [] as string[] }] }]
  const adapter = new MagpieAdapter({ catalog: () => groups, capture: () => ({ gatewayUrl: 'http://fixture.test', gatewayKey: 'test-only', provider: groups[0]!.route, model: groups[0]!.models[0]! }) })
  assert.equal(llm.listProviders().length, 0)
  const handle = llm.registerAdapter(groups.map(group => group.route), adapter)
  assert.equal(llm.listProviders()[0]?.name, 'Magpie · Codex')
  assert.equal((await llm.listModels(groups[0]!.route))[0]?.id, 'codex/model')
  groups = [{ route: 'magpie-workbuddy-test', upstream: 'workbuddy', name: 'Magpie · WorkBuddy', models: [{ id: 'workbuddy/model', name: 'Model', efforts: [] }] }]
  handle.replace(groups.map(group => group.route))
  assert.deepEqual(llm.listProviders().map(provider => provider.id), ['magpie-workbuddy-test'])
  groups = []
  handle.replace([])
  assert.equal(llm.listProviders().length, 0)
  handle()
})
test('RPC validates explicit creation consent without converting truthy strings', () => {
  assert.throws(() => readConnectInput({url:'http://example.test',loginKey:'x',createGatewayKey:'true'}))
  assert.throws(() => readConnectInput(null))
  assert.deepEqual(readConnectInput({url:'http://example.test',loginKey:'',createGatewayKey:false,gatewayUrl:'',gatewayKey:''}), {url:'http://example.test',loginKey:'',createGatewayKey:false})
})
