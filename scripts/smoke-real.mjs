// Explicitly authorized temporary key + at most ONE short model request. Never persists credentials.
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { MagpieTransport, ConnectorError } from '../lib/transport.js'
import { parseCatalog, providerNames } from '../lib/catalog.js'
import { MagpieAdapter } from '../lib/adapter.js'
const lines=(await fs.readFile(process.argv[2],'utf8')).split(/\r?\n/).filter(line=>line.trim()&&!line.trim().startsWith('#'))
const parsed=new URL(lines.map(line=>/https?:\/\/[^\s'"<>]+/.exec(line)?.[0]).find(Boolean))
const key=lines.find(line=>!line.includes('://')).replace(/^[^:=：]+[:=：]\s*/,'').trim().replace(/^(['"])(.*)\1$/,'$2')
// This explicit mapping is specific to the documented, authorized NAS deployment, never production auto-discovery.
const management=new URL(parsed);if(management.port==='13425')management.port='13430';management.pathname='/';management.search='';management.hash=''
const transport=new MagpieTransport();let cookie;let created;const name=`DSH test ${randomUUID()}`
let failed=false
try{
 cookie=await transport.login(management.origin,key)
 const listing=await transport.management(management.origin,cookie,'/api/providers')
 const added=await transport.management(management.origin,cookie,'/api/caller-keys/add-key',{name,readOnly:true})
 created=added.keys.find(row=>row.name===name)?.id
 if(!created||typeof added.secret!=='string')throw new Error('temporary credential unavailable')
 await transport.management(management.origin,cookie,'/api/caller-keys/access-key',{key:created,readOnly:false})
 const gatewayUrl=parsed.origin
 const data=await transport.gateway({gatewayUrl,gatewayKey:added.secret},'/v1/models')
 const groups=parseCatalog(data,providerNames(listing))
 console.log('PASS real directory grouped:',groups.map(g=>`${g.upstream}:${g.models.length}`).join(', '))
 const group=groups.find(g=>g.upstream==='codex'&&g.models.length)||groups.find(g=>g.upstream==='workbuddy'&&g.models.length)||groups.find(g=>g.upstream!=='group'&&g.models.length)
 if(!group)throw new Error('no callable models')
 const model=group.models[0]
 const adapter=new MagpieAdapter({catalog:()=>groups,capture:()=>({gatewayUrl,gatewayKey:added.secret,provider:group.route,model})})
 let textChars=0,tools=0,finished=false,usage=false
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000)
 try{
  for await(const chunk of adapter.stream({provider:group.route,model:model.id,messages:[{role:'user',content:[{type:'text',text:'Reply with exactly OK. Do not use tools.'}]}],maxTokens:128,signal:controller.signal})){
   if(chunk.type==='text-delta')textChars+=chunk.text.length
   if(chunk.type==='tool-call-delta')tools++
   if(chunk.type==='usage')usage=true
   if(chunk.type==='finish'){finished=chunk.reason.kind==='stop'||chunk.reason.kind==='max-tokens';if(chunk.reason.kind==='error')throw new Error('model error')}
  }
 }finally{clearTimeout(timer)}
 if(!finished||!textChars||tools)throw new Error('unexpected completion shape')
 console.log('PASS one real model call through MagpieAdapter:',{provider:group.upstream,model:model.id,textChars,usage,finished})
}catch(error){failed=true;console.error('FAIL real smoke:',error instanceof ConnectorError?error.message:'request did not complete as expected; sensitive details withheld')}
finally{
 if(cookie){try{if(!created){const rows=await transport.management(management.origin,cookie,'/api/caller-keys');created=rows.keys.find(row=>row.name===name)?.id}if(created){await transport.management(management.origin,cookie,'/api/caller-keys/remove-key',{key:created});const rows=await transport.management(management.origin,cookie,'/api/caller-keys');if(rows.keys.some(row=>row.id===created))throw new Error('still present');console.log('PASS temporary gateway key revoked and absence verified')}}catch{failed=true;console.error('WARNING temporary key cleanup not verified; revoke DSH test key in Magpie')}}
}
process.exitCode=failed?1:0
