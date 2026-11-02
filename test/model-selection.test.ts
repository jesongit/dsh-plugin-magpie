import test from 'node:test'
import assert from 'node:assert/strict'
import { createCurrentModelReader, ModelSelectionSource, selectedMagpieGroup } from '../src/client/model-selection.ts'
import type { CurrentModelReader, ModelSelection, ModelDirectoriesLike } from '../src/client/model-selection.ts'
import type { StatusView } from '../src/contracts.ts'
const a = { provider: 'magpie-codex-hash', model: 'codex/full-model' }
const b = { provider: 'manual-codex', model: 'codex/full-model' }
async function tick() { for(let i=0;i<12;i++)await Promise.resolve() }
function deferred<T>() { let resolve!: (value:T)=>void;let reject!: (error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject} }

test('current model reader uses only per-session sanctioned directory load, resolved lazily',async()=>{
 let available=false;let reads=0;const sessions:string[]=[]
 const directory:ModelDirectoriesLike={directoryFor(session){sessions.push(session);return{load:async()=>{reads++;return{current:a}}}}}
 const reader=createCurrentModelReader(()=>available?directory:undefined,'session-A')
 assert.equal(await reader(),undefined);assert.equal(reads,0)
 available=true;assert.deepEqual(await reader(),a);assert.deepEqual(sessions,['session-A'])
})
test('reader hides missing invalid and failed current values instead of guessing brands',async()=>{
 for(const current of [null,undefined,{provider:a.provider},{provider:'',model:'x'},{provider:'x',model:1}]){
  assert.equal(await createCurrentModelReader(()=>({directoryFor:()=>({load:async()=>({current})})}),'s')(),undefined)
 }
 const reader=createCurrentModelReader(()=>({directoryFor:()=>({load:async()=>({status:'error',current:a})})}),'s')
 assert.equal(await reader(),undefined)
})
test('selection mapping requires exact namespaced route plus explicit upstream',()=>{
 const group={route:a.provider,upstream:'codex',name:'Magpie · Codex',models:2}
 const status={configured:true,groups:[group]} as StatusView
 assert.equal(selectedMagpieGroup(a,status),group)
 for(const provider of ['codex','Magpie · Codex',a.provider+'-extra','manual-codex'])assert.equal(selectedMagpieGroup({provider,model:a.model},status),undefined)
 assert.equal(selectedMagpieGroup(a,{...status,configured:false}),undefined)
 assert.equal(selectedMagpieGroup(a,{...status,groups:[{...group,upstream:''}]}),undefined)
 assert.equal(selectedMagpieGroup(undefined,status),undefined)
})
test('polling is lazy, shared, nonoverlapping, equality-deduplicated and stops on last unsubscribe',async t=>{
 t.mock.timers.enable({apis:['setInterval']})
 let reads=0;let notifications=0;const pending=deferred<ModelSelection|undefined>()
 const source=new ModelSelectionSource(async()=>{reads++;return reads===1?pending.promise:a})
 assert.equal(reads,0);const stop=source.subscribe(()=>notifications++);const stop2=source.subscribe(()=>notifications++)
 assert.equal(reads,1);t.mock.timers.tick(9000);assert.equal(reads,1)
 pending.resolve(a);await tick();assert.equal(notifications,2)
 t.mock.timers.tick(3000);await tick();assert.equal(reads,2);assert.equal(notifications,2)
 stop();t.mock.timers.tick(3000);await tick();assert.equal(reads,3)
 stop2();assert.equal(source.getSnapshot(),undefined);t.mock.timers.tick(9000);assert.equal(reads,3)
 source.dispose()
})
test('poll failure or unavailable current hides previous selection rather than retaining stale quota routing',async t=>{
 t.mock.timers.enable({apis:['setInterval']})
 let current:ModelSelection|undefined=a;let fail=false
 const source=new ModelSelectionSource(async()=>{if(fail)throw new Error('private upstream diagnostic');return current})
 const stop=source.subscribe(()=>{});await tick();assert.deepEqual(source.getSnapshot(),a)
 fail=true;t.mock.timers.tick(3000);await tick();assert.equal(source.getSnapshot(),undefined)
 fail=false;current=b;t.mock.timers.tick(3000);await tick();assert.deepEqual(source.getSnapshot(),b)
 current=undefined;t.mock.timers.tick(3000);await tick();assert.equal(source.getSnapshot(),undefined)
 stop();source.dispose()
})
test('last unsubscribe and dispose fence late reads; remount waits for a fresh read',async()=>{
 const first=deferred<ModelSelection|undefined>();let reads=0
 const source=new ModelSelectionSource(async()=>++reads===1?first.promise:b)
 const stop=source.subscribe(()=>{});stop();const stop2=source.subscribe(()=>{})
 first.resolve(a);await tick();assert.equal(reads,2);assert.deepEqual(source.getSnapshot(),b)
 stop2();source.dispose();assert.equal(source.getSnapshot(),undefined)
 const late=deferred<ModelSelection|undefined>();const disposed=new ModelSelectionSource(()=>late.promise)
 disposed.subscribe(()=>assert.fail('disposed source published'));disposed.dispose();late.resolve(a);await tick();assert.equal(disposed.getSnapshot(),undefined)
})
test('actual SDK shared store pushes immediately and prevents periodic directory reloads',async t=>{
 t.mock.timers.enable({apis:['setInterval']})
 let current:ModelSelection|undefined=a;let reads=0;const listeners=new Set<()=>void>()
 const reader=createCurrentModelReader(()=>({directoryFor:()=>({load:async()=>{reads++;return{current}},store:{getSnapshot:()=>({current}),subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener)}}}})}),'s')
 const source=new ModelSelectionSource(reader);const stop=source.subscribe(()=>{})
 await tick();assert.deepEqual(source.getSnapshot(),a);assert.equal(listeners.size,1)
 current=b;for(const listener of listeners)listener();assert.deepEqual(source.getSnapshot(),b)
 t.mock.timers.tick(12000);await tick();assert.equal(reads,1)
 stop();assert.equal(listeners.size,0);assert.equal(source.getSnapshot(),undefined);source.dispose()
})
test('observable revision wins over stale in-flight load and callback cannot outlive unsubscribe',async()=>{
 const pending=deferred<ModelSelection|undefined>();let publish:((selection:ModelSelection|undefined)=>void)|undefined
 const reader:CurrentModelReader=()=>pending.promise
 reader.subscribe=callback=>{publish=callback;return()=>{}}
 const source=new ModelSelectionSource(reader);const stop=source.subscribe(()=>{})
 publish!(b);pending.resolve(a);await tick();assert.deepEqual(source.getSnapshot(),b)
 stop();publish!(a);assert.equal(source.getSnapshot(),undefined);source.dispose()
})
test('lazy service registration upgrades fallback polling to the SDK observable',async t=>{
 t.mock.timers.enable({apis:['setInterval']})
 let available=false;let reads=0;const listeners=new Set<()=>void>()
 const reader=createCurrentModelReader(()=>available?{directoryFor:()=>({load:async()=>{reads++;return{current:a}},store:{getSnapshot:()=>({current:a}),subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener)}}}})}:undefined,'s')
 const source=new ModelSelectionSource(reader);const stop=source.subscribe(()=>{});await tick();assert.equal(source.getSnapshot(),undefined)
 available=true;t.mock.timers.tick(3000);await tick();assert.deepEqual(source.getSnapshot(),a);assert.equal(listeners.size,1)
 t.mock.timers.tick(12000);await tick();assert.equal(reads,1)
 stop();source.dispose()
})
