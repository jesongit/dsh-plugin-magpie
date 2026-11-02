import test from 'node:test'
import assert from 'node:assert/strict'
import { RetainedSurface } from '../src/client/retained-surface.ts'
import type { ClientSnapshot } from '../src/client/state.ts'
import type { StatusView } from '../src/contracts.ts'
const status: StatusView = { configured: true, connected: true, url: 'https://magpie.test', gatewayUrl: 'https://magpie.test', hasLoginKey: true, hasGatewayKey: true, groups: [], modelCount: 0, syncedAt: 1, stale: false, error: null, version: null }
function setup(configured = true) {
  let value: ClientSnapshot = { status: configured ? status : null, connectionEpoch: 0, busy: false, error: null, quota: null }
  const listeners = new Set<() => void>()
  const source = { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const surface = new RetainedSurface(source)
  const update = (patch: Partial<ClientSnapshot>) => { value = { ...value, ...patch }; for (const listener of listeners) listener() }
  return { surface, update, listenerCount: () => listeners.size }
}
const bounds = { left: 180, top: 40, width: 900, height: 700 }
test('retained guest is lazy and survives ordinary panel anchor detach/remount without generation change', () => {
  const {surface} = setup()
  assert.equal(surface.getSnapshot().activated, false)
  const a={};surface.attach(a);surface.setBounds(a,bounds)
  const active=surface.getSnapshot();assert.equal(active.activated,true)
  surface.detach(a)
  assert.equal(surface.getSnapshot().bounds,null)
  assert.equal(surface.getSnapshot().activated,true)
  assert.equal(surface.getSnapshot().generation,active.generation)
  const b={};surface.attach(b);surface.setBounds(b,bounds)
  assert.equal(surface.getSnapshot().generation,active.generation)
  assert.deepEqual(surface.getSnapshot().bounds,bounds)
  surface.dispose()
})
test('directory reads/refresh never reset a retained page, committed same-url reconnect does', () => {
  const {surface,update}=setup();const owner={};surface.attach(owner);surface.setBounds(owner,bounds)
  const generation=surface.getSnapshot().generation
  update({status:{...status,syncedAt:2,stale:true}})
  assert.equal(surface.getSnapshot().generation,generation)
  update({status:{...status,syncedAt:3},connectionEpoch:1})
  assert.equal(surface.getSnapshot().generation,generation+1)
  assert.equal(surface.getSnapshot().activated,true)
  surface.dispose()
})
test('disconnect drops retained content while hidden and next connection waits for activation', () => {
  const {surface,update}=setup();const owner={};surface.attach(owner);surface.setBounds(owner,bounds);surface.detach(owner)
  const generation=surface.getSnapshot().generation
  update({status:{...status,configured:false,hasLoginKey:false,url:''},connectionEpoch:1})
  assert.equal(surface.getSnapshot().url,null)
  assert.equal(surface.getSnapshot().activated,false)
  assert.equal(surface.getSnapshot().generation,generation+1)
  update({status:{...status,url:'https://other.test'},connectionEpoch:2})
  assert.equal(surface.getSnapshot().activated,false)
  const next={};surface.attach(next);surface.setBounds(next,bounds)
  assert.equal(surface.getSnapshot().activated,true)
  surface.dispose()
})
test('stale anchor cleanup cannot hide a replacement, geometry equality avoids rerenders, disposal unsubscribes', () => {
  const {surface,listenerCount}=setup();const a={},b={};let changes=0;surface.subscribe(()=>changes++)
  surface.attach(a);surface.setBounds(a,bounds);surface.setBounds(a,{...bounds});assert.equal(changes,1)
  surface.attach(b);surface.setBounds(b,{...bounds,left:200});surface.detach(a)
  assert.equal(surface.getSnapshot().bounds?.left,200)
  surface.setBounds(a,{...bounds,left:100});assert.equal(surface.getSnapshot().bounds?.left,200)
  surface.setBounds(b,{...bounds,width:NaN});assert.equal(surface.getSnapshot().bounds,null)
  assert.equal(surface.getSnapshot().activated,true)
  surface.dispose();assert.equal(listenerCount(),0);assert.equal(surface.getSnapshot().activated,false)
  surface.setBounds(b,bounds);assert.equal(surface.getSnapshot().bounds,null)
})
