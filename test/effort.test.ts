import test from 'node:test'
import assert from 'node:assert/strict'
import type { CatalogModel, GenerateOptions } from '../src/contracts.ts'
import { chatRequest, effectiveEffort } from '../src/protocol.ts'

const model = (efforts: string[]): CatalogModel => ({ id: 'codex/gpt', name: 'GPT', efforts })
const options = (effort?: string): GenerateOptions => ({ messages: [], tools: [], toolHistory: [], ...(effort === undefined ? {} : { reasoningEffort: effort }) }) as GenerateOptions

test('default effort is high, first advertised effort without high, and explicit picks win', () => {
  assert.equal(effectiveEffort(options(), model(['low', 'medium', 'high', 'xhigh'])), 'high')
  assert.equal(effectiveEffort(options(), model(['minimal', 'low'])), 'minimal')
  assert.equal(effectiveEffort(options('xhigh'), model(['low', 'high', 'xhigh'])), 'xhigh')
  assert.equal(effectiveEffort(options(), model([])), undefined)
  assert.throws(() => effectiveEffort(options('ultra'), model(['low', 'high'])), /does not advertise/)
})

test('chat request sends the effective effort and never a default artifact', async () => {
  const high = await chatRequest(options(), model(['low', 'medium', 'high']))
  assert.equal(high.reasoning_effort, 'high')
  const fallback = await chatRequest(options(), model(['minimal', 'low']))
  assert.equal(fallback.reasoning_effort, 'minimal')
  const picked = await chatRequest(options('low'), model(['low', 'high']))
  assert.equal(picked.reasoning_effort, 'low')
  const silent = await chatRequest(options(), model([]))
  assert.equal('reasoning_effort' in silent, false)
})

test('adapter metadata always declares high or first effort as the picker default', async () => {
  const { MagpieAdapter } = await import('../src/adapter.ts')
  const group = { route: 'r', upstream: 'u', name: 'U', models: [model(['minimal', 'low']), model(['low', 'medium', 'high'])] }
  const adapter = new MagpieAdapter({ catalog: () => [group], capture: () => { throw new Error('unused') }, sessionTier: () => 'standard' })
  const models = await adapter.listModels('r')
  assert.equal(models[0]?.reasoning?.defaultEffort, 'minimal')
  assert.equal(models[1]?.reasoning?.defaultEffort, 'high')
})
