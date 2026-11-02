import test from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { MagpieClient } from '../src/client/state.ts'
test('only committed connect and disconnect invalidate the retained browser generation',async()=>{
 let fail=false
 const rpc={call:async()=>fail?{ok:false,error:{message:'fixture failure'}}:{ok:true,value:{configured:true,url:'https://fixture.test',hasLoginKey:true}}} as ConnectionHandle['rpc']
 const client=new MagpieClient(rpc)
 assert.equal(client.getSnapshot().connectionEpoch,0)
 await client.read(true);await client.refresh();assert.equal(client.getSnapshot().connectionEpoch,0)
 await client.connect({url:'https://fixture.test',loginKey:'fixture',createGatewayKey:false});assert.equal(client.getSnapshot().connectionEpoch,1)
 fail=true;await client.connect({url:'https://fixture.test',loginKey:'fixture',createGatewayKey:false});assert.equal(client.getSnapshot().connectionEpoch,1)
 fail=false;await client.refresh();assert.equal(client.getSnapshot().connectionEpoch,1)
 await client.disconnect();assert.equal(client.getSnapshot().connectionEpoch,2)
 client.dispose()
})
