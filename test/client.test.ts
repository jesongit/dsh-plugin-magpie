import test from 'node:test'
import assert from 'node:assert/strict'
import { MagpieClient } from '../src/client/state.ts'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { StatusView } from '../src/contracts.ts'
const status: StatusView = { configured: true, connected: true, url: 'http://example.test', gatewayUrl: 'http://example.test', hasLoginKey: true, hasGatewayKey: true, groups: [], modelCount: 0, syncedAt: 1, stale: false, error: null, version: null }
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r}); return {promise,resolve} }
test('late status response never overwrites a newer connect generation', async () => {
  const old=deferred<unknown>()
  const rpc={call: async (_channel:string, endpoint:string) => endpoint==='magpie.status' ? old.promise : {ok:true,value:status}} as ConnectionHandle['rpc']
  const client=new MagpieClient(rpc)
  const read=client.read()
  assert.equal(await client.connect({url:status.url,loginKey:'test-only',createGatewayKey:false}),true)
  old.resolve({ok:true,value:{...status,configured:false,url:''}})
  await read
  assert.equal(client.getSnapshot().status?.configured,true)
  client.dispose()
})
test('quota response from previous connection cannot repopulate after disconnect', async () => {
  const old=deferred<unknown>()
  const rpc={call:async(_channel:string,endpoint:string)=>endpoint==='magpie.quotas'?old.promise:{ok:true,value:{...status,configured:false}}} as ConnectionHandle['rpc']
  const client=new MagpieClient(rpc)
  const quota=client.quotas()
  await client.disconnect()
  old.resolve({ok:true,value:{updatedAt:1,stale:false,error:null,summaries:[{provider:'old',label:'old',text:'stale'}]}})
  await quota
  assert.equal(client.getSnapshot().quota,null)
  client.dispose()
})
