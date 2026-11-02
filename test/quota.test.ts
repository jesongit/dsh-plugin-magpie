import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeQuotas } from '../src/quota.ts'
import type { CatalogGroup } from '../src/contracts.ts'
const now=Date.UTC(2026,10,3)
const iso=(offset=0)=>new Date(now+offset).toISOString()
const catalog:CatalogGroup[]=[{route:'magpie-codex-hash',upstream:'codex',name:'Magpie · Codex',models:[]}]
test('kept quota rows are grouped by provider, preserving anonymous multiple accounts and exact percent windows',()=>{
 const result=normalizeQuotas({data:[{provider:'codex',kind:'subscription',plan:'Plus',user:'private@example.com',name:'private-account',readAt:iso(),windows:[{name:'5h',remaining:25,used:75,resetsAt:iso(3600000),amount:75,limit:100,unit:'credits',pool:'shared'}]},{provider:'codex',kind:'plan',asOf:iso(-600000),windows:[{remaining:42}]}]},catalog,now)
 assert.equal(result.providers?.length,1)
 const provider=result.providers![0]!
 assert.equal(provider.label,'Magpie · Codex');assert.equal(provider.accounts.length,2)
 const first=provider.accounts[0]!,second=provider.accounts[1]!
 assert.equal(first.label,'账号1');assert.equal(first.id,'account-1');assert.equal(first.plan,'Plus');assert.equal(first.stale,false);assert.equal(first.readAt,now)
 assert.deepEqual(first.windows[0],{kind:'percentage',label:'5h',remaining:25,used:75,amount:75,limit:100,unit:'credits',pool:'shared',resetsAt:now+3600000})
 assert.equal(second.id,'account-2');assert.equal(second.stale,true)
 assert.match(result.summaries[0]!.text,/25%/)
 assert.ok(!JSON.stringify(result).includes('private'))
})
test('balance, text and unlimited never turn their non-share fields into percentage gauges',()=>{
 const result=normalizeQuotas({data:[{provider:'wallet',kind:'balance',balance:'$12.50',readAt:iso(),windows:[{name:'wallet',balance:6291,unit:'points',remaining:0,used:0},{name:'quota',text:true,display:'1.2k / 3k',remaining:0,used:0},{name:'unlimited',unlimited:true,remaining:0,used:100},{name:'expiring',remaining:80,runsOutAt:iso(86400000)}]}]},[],now)
 const account=result.providers![0]!.accounts[0]!
 assert.equal(account.balance,'$12.50');assert.equal(account.unavailable,false)
 assert.deepEqual(account.windows[0],{kind:'balance',label:'wallet',amount:6291,unit:'points'})
 assert.deepEqual(account.windows[1],{kind:'text',label:'quota',display:'1.2k / 3k'})
 assert.deepEqual(account.windows[2],{kind:'unlimited',label:'unlimited'})
 assert.equal(account.windows[3]?.runsOutAt,now+86400000)
 assert.match(result.summaries[0]!.text,/80%/)
})
test('missing, future and invalid readings are explicitly stale; errors never expose account text',()=>{
 const result=normalizeQuotas({data:[{provider:'codex',kind:'surprise',user:'email@test',alias:'alias-secret',from:'host-secret',error:'token=raw-secret',windows:[]},{provider:'codex',readAt:iso(120000),windows:[{remaining:50}]},{provider:'codex',readAt:'not-a-time',asOf:iso(),readDeferred:true,windows:[{remaining:10}]}]},catalog,now)
 const accounts=result.providers![0]!.accounts
 assert.equal(accounts[0]?.kind,'unknown');assert.equal(accounts[0]?.unavailable,true);assert.equal(accounts[0]?.stale,true);assert.equal(accounts[0]?.readAt,undefined)
 assert.equal(accounts[1]?.stale,true);assert.equal(accounts[1]?.readAt,undefined)
 assert.equal(accounts[2]?.stale,true)
 const json=JSON.stringify(result);for(const secret of ['email@test','alias-secret','host-secret','raw-secret'])assert.ok(!json.includes(secret))
})
test('numeric values and absolute epochs are finite and bounded, malformed windows remain unknown not false zero',()=>{
 const result=normalizeQuotas({data:[{provider:'codex',windows:[{remaining:NaN},{remaining:Infinity},{used:-5,remaining:500,resetsAt:1,runsOutAt:Infinity},{balance:1e16},{text:true},{unlimited:true,limit:-5,amount:NaN}]}]},catalog,now)
 const account=result.providers![0]!.accounts[0]!
 assert.equal(account.windows.length,2)
 assert.deepEqual(account.windows[0],{kind:'percentage',label:'窗口3',remaining:100,used:0})
 assert.deepEqual(account.windows[1],{kind:'unlimited',label:'窗口6'})
 assert.ok(!JSON.stringify(result).includes('null'))
 assert.throws(()=>normalizeQuotas({},catalog,now))
})
test('public allowlist drops malicious display strings and sensitive keys while bounding rows windows and labels',()=>{
 const windows=[{name:'someone@example.com',text:true,display:'Bearer exposed-token'},{name:'safe',remaining:10,unit:'https://private.test',pool:'api_key SECRET',display:'actual-private-login'},{name:'x'.repeat(81),remaining:5},...Array.from({length:70},()=>({remaining:20}))]
 const row={provider:'codex',name:'PRIVATE',user:'private@example.com',alias:'PRIVATE',from:'PRIVATE',seat:'PRIVATE',error:'PRIVATE',plan:'actual-private-login',balance:'https://private.test',windows}
 const result=normalizeQuotas({data:Array.from({length:300},()=>row)},catalog,now,['actual-private-login'])
 assert.equal(result.providers![0]!.accounts.length,256)
 assert.equal(result.providers![0]!.accounts[0]!.windows.length,63)
 const account=result.providers![0]!.accounts[0]!
 assert.equal(account.plan,undefined);assert.equal(account.balance,undefined)
 assert.deepEqual(account.windows[0],{kind:'percentage',label:'safe',remaining:10,used:90})
 assert.equal(account.windows[1]?.label,'窗口3')
 const json=JSON.stringify(result)
 for(const privateText of ['PRIVATE','private@example.com','actual-private-login','private.test','exposed-token','SECRET'])assert.ok(!json.includes(privateText))
})
test('zero-width padding and full-width characters cannot smuggle addresses or identity text into public fields',()=>{
 const result=normalizeQuotas({data:[{provider:'codex',plan:'http\u200b://private.test',balance:'user\uff20host',windows:[{name:'safe\u200b',remaining:10,display:'user\uff20host'}]}]},catalog,now)
 const account=result.providers![0]!.accounts[0]!
 assert.equal(account.plan,undefined);assert.equal(account.balance,undefined)
 assert.deepEqual(account.windows[0],{kind:'percentage',label:'safe',remaining:10,used:90})
 assert.ok(!JSON.stringify(result).includes('private.test'));assert.ok(!JSON.stringify(result).includes('user@host'))
})
test('an explicit used-only percentage yields its complementary remaining share, not zero',()=>{
 const result=normalizeQuotas({data:[{provider:'codex',windows:[{name:'5h',used:20}]}]},catalog,now)
 assert.equal(result.providers![0]!.accounts[0]!.windows[0]!.remaining,80)
})
test('balance-only and empty accounts keep no-percentage summary rather than misrepresenting zero percent',()=>{
 const result=normalizeQuotas({data:[{provider:'wallet',balance:'12.5 credits',windows:[]},{provider:'wallet',windows:[{balance:25,remaining:0}]}]},[],now)
 assert.match(result.summaries[0]!.text,/No percentage reading/)
 assert.equal(result.providers![0]!.accounts[0]?.unavailable,false)
 assert.equal(result.providers![0]!.accounts[1]?.unavailable,false)
})
