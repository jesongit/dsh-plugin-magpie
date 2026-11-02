import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mountNativeView, nativeBridge } from '../src/client/native-view.ts'
import type { NativeBridge, NativeLaunchClient, NativeState, NativeWebview } from '../src/client/native-view.ts'
function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (error:unknown)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no}); return {promise,resolve,reject} }
async function tick() { for(let n=0;n<12;n++)await Promise.resolve() }
class FakeView implements NativeWebview {
  attributes=new Map<string,string>()
  listeners=new Map<string,Set<EventListener>>()
  loads:string[]=[]
  scripts:string[]=[]
  removed=0
  url=''
  load:()=>Promise<void>=()=>Promise.resolve()
  execute:()=>Promise<unknown>=()=>Promise.resolve(true)
  setAttribute(name:string,value:string){this.attributes.set(name,value);if(name==='src')this.url=value}
  addEventListener(name:string,listener:EventListener){const set=this.listeners.get(name)??new Set();set.add(listener);this.listeners.set(name,set)}
  removeEventListener(name:string,listener:EventListener){this.listeners.get(name)?.delete(listener)}
  getURL(){return this.url}
  loadURL(url:string){this.loads.push(url);return this.load()}
  executeJavaScript(code:string){this.scripts.push(code);return this.execute()}
  remove(){this.removed++}
  emit(name:string,fields:Record<string,unknown>={}){const event=Object.assign(new Event(name),fields);for(const listener of [...this.listeners.get(name)??[]])listener(event)}
  listenerCount(){return [...this.listeners.values()].reduce((sum,set)=>sum+set.size,0)}
}
function setup(patch:{bridge?:NativeBridge;client?:Partial<NativeLaunchClient>;managementUrl?:string;view?:FakeView}={}){
 const view=patch.view??new FakeView();const appended:unknown[]=[];const states:NativeState[]=[];const acquisitions:string[]=[];const releases:string[]=[];const revoked:string[]=[];const calls:string[]=[]
 const client:NativeLaunchClient={
  launchIssue:async signal=>{assert.equal(signal?.aborted,false);calls.push('issue');return{token:'opaque-test-ticket',expiresAt:Date.now()+30000}},
  launchRedeem:async(token,signal)=>{assert.equal(signal?.aborted,false);assert.equal(token,'opaque-test-ticket');calls.push('redeem');return{url:'https://magpie.test/_magpie/sign-in',body:'key=fake%2Bsecret&back=%2F'}},
  launchRevoke:async token=>{revoked.push(token)},...patch.client,
 }
 const bridge=patch.bridge??{acquire:async(key:string)=>{acquisitions.push(key);return{lease:'test-lease',partition:'test-isolated-partition'}},release:async(id:string)=>{releases.push(id)}}
 const host={appendChild:(node:unknown)=>{appended.push(node)}} as unknown as HTMLElement
 const dispose=mountNativeView(host,client,{bridge,managementUrl:patch.managementUrl??'https://magpie.test',storageKey:'magpie-only-plugin-isolation',onState:state=>states.push(state),createElement:()=>view})
 return{view,appended,states,acquisitions,releases,revoked,calls,dispose}
}
async function signin(f:ReturnType<typeof setup>,status=401){await tick();f.view.emit('dom-ready');await tick();assert.deepEqual(f.view.loads,['https://magpie.test/']);f.view.url=f.view.loads[0]!;f.view.emit('did-navigate',{url:f.view.url,httpResponseCode:status});f.view.emit('dom-ready');await tick()}
async function submitted(f:ReturnType<typeof setup>){await signin(f);assert.equal(f.view.scripts.length,1);assert.deepEqual(f.view.loads,['https://magpie.test/','https://magpie.test/'])}
function commit(view:FakeView,url='https://magpie.test/',status=200){view.url=url;view.emit('did-start-navigation',{isMainFrame:true,url});view.emit('did-navigate',{url,httpResponseCode:status})}

test('nativeBridge only accepts protocol v1 with acquire/release functions',()=>{
 const global=globalThis as unknown as{dshDesktop?:unknown};const previous=Object.getOwnPropertyDescriptor(globalThis,'dshDesktop')
 try{global.dshDesktop={protocolVersion:2,browser:{acquire(){},release(){}}};assert.equal(nativeBridge(),undefined);global.dshDesktop={protocolVersion:1,browser:{acquire(){}}};assert.equal(nativeBridge(),undefined);const browser={acquire(){},release(){}};global.dshDesktop={protocolVersion:1,browser};assert.equal(nativeBridge(),browser)}finally{if(previous)Object.defineProperty(globalThis,'dshDesktop',previous);else delete global.dshDesktop}
})
test('approved blank lease then keyless GET before owner redemption and one fixed manual-fetch script',async()=>{
 const f=setup();await tick();assert.deepEqual(f.acquisitions,['magpie-only-plugin-isolation']);assert.equal(f.appended[0],f.view)
 assert.equal(f.view.attributes.get('src'),'about:blank#test-lease');assert.equal(f.view.attributes.get('name'),'test-lease');assert.equal(f.view.attributes.get('partition'),'test-isolated-partition')
 for(const unsafe of['nodeintegration','preload','disablewebsecurity','webpreferences'])assert.equal(f.view.attributes.has(unsafe),false)
 assert.deepEqual(f.calls,[]);f.view.emit('dom-ready');await tick();assert.deepEqual(f.calls,[]);assert.deepEqual(f.view.loads,['https://magpie.test/'])
 f.view.url=f.view.loads[0]!;f.view.emit('did-navigate',{url:f.view.url,httpResponseCode:401});f.view.emit('dom-ready');await tick()
 assert.deepEqual(f.calls,['issue','redeem']);assert.equal(f.view.scripts.length,1);assert.equal(f.view.loads[1],'https://magpie.test/')
 assert.equal(JSON.stringify(f.view.loads).includes('secret'),false);assert.equal(JSON.stringify(f.states).includes('secret'),false)
 f.dispose();assert.deepEqual(f.releases,['test-lease']);assert.equal(f.view.removed,1);assert.equal(f.view.listenerCount(),0);f.dispose();assert.deepEqual(f.releases,['test-lease'])
})
test('fixed login script guards location and uses manual redirect, same-origin credentials and original form without DOM reads',async()=>{
 const body='key='+encodeURIComponent('fake</script>"\\\nsecret')+'&back=%2F'
 const f=setup({client:{launchRedeem:async()=>({url:'https://magpie.test/_magpie/sign-in',body})}});await submitted(f)
 let fetches=0;let request:unknown
 const source=f.view.scripts[0]!
 const run=(location:Record<string,string>,response:Record<string,unknown>)=>vm.runInNewContext(source,{URL,location,fetch:async(url:string,options:unknown)=>{fetches++;request={url,options};return response}})
 assert.equal(await run({href:'https://attacker.test/',origin:'https://attacker.test'},{type:'opaqueredirect'}),false);assert.equal(fetches,0)
 assert.equal(await run({href:'https://magpie.test/?changed=1',origin:'https://magpie.test'},{type:'opaqueredirect'}),false);assert.equal(fetches,0)
 assert.equal(await run({href:'https://magpie.test/',origin:'https://magpie.test'},{type:'opaqueredirect',status:0}),true)
 assert.deepEqual(JSON.parse(JSON.stringify(request)),{url:'https://magpie.test/_magpie/sign-in',options:{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,credentials:'same-origin',redirect:'manual'}})
 for(const status of[200,307,308,401])assert.equal(await run({href:'https://magpie.test/',origin:'https://magpie.test'},{type:'basic',status}),false)
 assert.equal(await run({href:'https://magpie.test/',origin:'https://magpie.test'},{type:'basic',status:303}),true)
 assert.equal(await run({href:'https://magpie.test/#providers',origin:'https://magpie.test'},{type:'opaqueredirect'}),true)
 assert.equal(await run({href:'https://magpie.test/?view=providers&edit=X&tab=usage#settings',origin:'https://magpie.test'},{type:'opaqueredirect'}),true)
 assert.equal(await run({href:'https://magpie.test/?edit='+('x'.repeat(256)),origin:'https://magpie.test'},{type:'opaqueredirect'}),true)
 const beforeRejected=fetches
 for(const href of['https://magpie.test/?k=secret#providers','https://magpie.test/?unknown=providers','https://magpie.test/?view=a&view=b','https://magpie.test/?tab='+('x'.repeat(257)),'https://magpie.test/other#providers','https://user@magpie.test/#providers','https://attacker.test/#providers'])assert.equal(await run({href,origin:new URL(href).origin},{type:'opaqueredirect'}),false)
 assert.equal(fetches,beforeRejected)
 assert.equal(source.includes('document.'),false);f.dispose()
})
test('ready needs HTTP200 same-origin main commitment plus dom-ready/stop, not RPC/script/native load completion',async()=>{
 const f=setup();await submitted(f);assert.equal(f.states.at(-1)?.phase,'loading');f.view.emit('did-stop-loading');assert.equal(f.states.at(-1)?.phase,'loading')
 f.view.url='https://magpie.test/';f.view.emit('did-navigate',{isMainFrame:false,url:f.view.url,httpResponseCode:200});f.view.emit('dom-ready');assert.equal(f.states.at(-1)?.phase,'loading')
 commit(f.view);assert.equal(f.states.at(-1)?.phase,'loading');f.view.emit('dom-ready');assert.equal(f.states.at(-1)?.phase,'ready');assert.equal(f.view.scripts.length,1);f.dispose()
 const g=setup();await submitted(g);commit(g.view);g.view.emit('did-stop-loading');assert.equal(g.states.at(-1)?.phase,'ready');g.dispose()
})
test('keyless root 401 document is accepted, but DNS/TLS failure is never hidden as authentication',async()=>{
 const view=new FakeView();const pending=deferred<void>();view.load=()=>pending.promise
 const f=setup({view});await tick();view.emit('dom-ready');await tick();view.url='https://magpie.test/';view.emit('did-navigate',{url:view.url,httpResponseCode:401});view.emit('did-fail-load',{isMainFrame:true,errorCode:-379});pending.reject(new Error('HTTP401'));await tick();assert.notEqual(f.states.at(-1)?.phase,'error');view.emit('dom-ready');await tick();assert.equal(f.calls[0],'issue');f.dispose()
 for(const errorCode of[-105,-202,-7]){const g=setup();await tick();g.view.emit('dom-ready');await tick();g.view.url='https://magpie.test/';g.view.emit('did-fail-load',{isMainFrame:true,errorCode});assert.equal(g.states.at(-1)?.phase,'error');assert.equal(g.calls.length,0);assert.deepEqual(g.releases,['test-lease'])}
})
test('existing-cookie root200 bootstrap performs one explicit login and clean GET, never GETs POST-only endpoint',async()=>{
 const f=setup();await signin(f,200)
 assert.deepEqual(f.calls,['issue','redeem']);assert.equal(f.view.scripts.length,1)
 assert.deepEqual(f.view.loads,['https://magpie.test/','https://magpie.test/'])
 assert.equal(f.view.loads.includes('https://magpie.test/_magpie/sign-in'),false)
 commit(f.view);f.view.emit('dom-ready');assert.equal(f.states.at(-1)?.phase,'ready');f.dispose()
})
test('sign-in redirect or nonconfigured DOM-ready rejects before issue/redeem, including same-origin other path',async()=>{
 for(const url of['https://attacker.test/','https://magpie.test/other','https://magpie.test/_magpie/sign-in?k=x']){
  const f=setup();await tick();f.view.emit('dom-ready');await tick();f.view.url=url;f.view.emit('did-navigate',{url,httpResponseCode:200});f.view.emit('dom-ready');await tick();assert.equal(f.calls.length,0);assert.equal(f.view.scripts.length,0);assert.equal(f.states.at(-1)?.phase,'error');assert.deepEqual(f.releases,['test-lease'])
 }
})
test('clean root request rejects non200, sign-in page and cross-origin and never retries authentication',async()=>{
 for(const [url,status]of[['https://magpie.test/',401],['https://magpie.test/',500],['https://magpie.test/',204],['https://magpie.test/_magpie/sign-in',200],['https://attacker.test/',200],['https://magpie.test/?k=bad',200]] as const){
  const f=setup();await submitted(f);commit(f.view,url,status);f.view.emit('dom-ready');assert.equal(f.states.at(-1)?.phase,'error');assert.equal(f.view.scripts.length,1);assert.equal(f.view.loads.length,2);assert.deepEqual(f.releases,['test-lease']);assert.equal(f.view.listenerCount(),0)
 }
})
test('subframe failures and provisional abort do not fail main loading; termination releases safely',async()=>{
 const f=setup();await submitted(f);f.view.emit('did-fail-load',{isMainFrame:false,errorCode:-2});f.view.emit('did-fail-load',{isMainFrame:true,errorCode:-3});assert.equal(f.states.at(-1)?.phase,'loading');commit(f.view);f.view.emit('did-stop-loading');assert.equal(f.states.at(-1)?.phase,'ready');f.view.emit('render-process-gone',{reason:'secret'});assert.equal(f.states.at(-1)?.phase,'error');assert.deepEqual(f.releases,['test-lease']);assert.equal(f.view.listenerCount(),0);assert.equal(JSON.stringify(f.states).includes('secret'),false)
})
test('pending acquisition after cancellation releases late lease without creating a guest',async()=>{
 const acquire=deferred<{lease:string;partition:string}>();const releases:string[]=[];const f=setup({bridge:{acquire:()=>acquire.promise,release:async id=>{releases.push(id)}}});f.dispose();acquire.resolve({lease:'late',partition:'late-partition'});await tick();assert.deepEqual(releases,['late']);assert.equal(f.appended.length,0);assert.equal(f.calls.length,0)
})
test('late issue is revoked, late redemption never executes, late script never navigates after disposal',async()=>{
 const issue=deferred<{token:string;expiresAt:number}>();const f=setup({client:{launchIssue:()=>issue.promise}});await signin(f);f.dispose();issue.resolve({token:'late-token',expiresAt:Date.now()+30000});await tick();assert.deepEqual(f.revoked,['late-token']);assert.equal(f.view.scripts.length,0)
 const redeem=deferred<{url:string;body:string}>();const g=setup({client:{launchRedeem:()=>redeem.promise}});await signin(g);g.dispose();redeem.resolve({url:'https://magpie.test/_magpie/sign-in',body:'key=fake'});await tick();assert.deepEqual(g.revoked,['opaque-test-ticket']);assert.equal(g.view.scripts.length,0)
 const execution=deferred<unknown>();const view=new FakeView();view.execute=()=>execution.promise;const h=setup({view});await signin(h);h.dispose();execution.resolve(true);await tick();assert.equal(view.loads.length,1);assert.deepEqual(h.releases,['test-lease']);assert.equal(view.listenerCount(),0)
})
test('duplicate events never duplicate owner ticket issue or fixed login execution',async()=>{
 const f=setup();await tick();f.view.emit('dom-ready');await tick();f.view.url='https://magpie.test/';f.view.emit('did-navigate',{url:f.view.url,httpResponseCode:401});f.view.emit('dom-ready');f.view.emit('dom-ready');await tick();assert.equal(f.calls.filter(x=>x==='issue').length,1);assert.equal(f.view.scripts.length,1)
 f.dispose();const count=f.states.length;f.view.emit('dom-ready');f.view.emit('did-navigate',{url:'https://magpie.test/',httpResponseCode:200});assert.equal(f.states.length,count)
})
test('stale blank DOM-ready and navigation notifications do not authenticate or reject a pending root load',async()=>{
 const f=setup();await tick();f.view.emit('dom-ready');await tick()
 assert.equal(f.view.url,'about:blank#test-lease');assert.deepEqual(f.view.loads,['https://magpie.test/'])
 f.view.emit('dom-ready');f.view.emit('did-navigate',{url:'about:blank#test-lease',httpResponseCode:-1});f.view.emit('dom-ready');await tick()
 assert.equal(f.calls.length,0);assert.notEqual(f.states.at(-1)?.phase,'error');assert.equal(f.view.scripts.length,0)
 f.view.url='https://magpie.test/';f.view.emit('did-navigate',{url:f.view.url,httpResponseCode:401});await tick()
 assert.equal(f.calls.length,0) // stale blank DOM-ready was not carried into the new document.
 f.view.emit('dom-ready');await tick();assert.deepEqual(f.calls,['issue','redeem']);assert.equal(f.view.scripts.length,1);f.dispose()
})
test('root DOM-ready before main navigation waits for a real 200/401 commitment',async()=>{
 const f=setup();await tick();f.view.emit('dom-ready');await tick();f.view.url='https://magpie.test/'
 f.view.emit('dom-ready');await tick();assert.equal(f.calls.length,0);assert.equal(f.view.scripts.length,0)
 f.view.emit('did-navigate',{isMainFrame:false,url:f.view.url,httpResponseCode:200});await tick();assert.equal(f.calls.length,0)
 f.view.emit('did-navigate',{isMainFrame:true,url:f.view.url,httpResponseCode:401});await tick();assert.deepEqual(f.calls,['issue','redeem']);assert.equal(f.view.scripts.length,1);f.dispose()
 const g=setup();await tick();g.view.emit('dom-ready');await tick();g.view.url='https://magpie.test/';g.view.emit('dom-ready');g.view.emit('did-navigate',{url:g.view.url,httpResponseCode:500});await tick();assert.equal(g.calls.length,0);assert.equal(g.states.at(-1)?.phase,'error');g.dispose()
})
test('root-only fragments survive bootstrap and redemption without permitting queries paths or origins',async()=>{
 const redemption=deferred<{url:string;body:string}>();const f=setup({client:{launchRedeem:()=>redemption.promise}})
 await tick();f.view.emit('dom-ready');await tick();f.view.url='https://magpie.test/#providers';f.view.emit('did-navigate',{url:'https://magpie.test/',httpResponseCode:200});f.view.emit('dom-ready');await tick();assert.equal(f.calls[0],'issue')
 f.view.url='https://magpie.test/#settings';redemption.resolve({url:'https://magpie.test/_magpie/sign-in',body:'key=fake&back=%2F'});await tick();assert.equal(f.view.scripts.length,1);assert.equal(f.view.loads.length,2)
 commit(f.view,'https://magpie.test/#providers');f.view.emit('dom-ready');assert.equal(f.states.at(-1)?.phase,'ready');f.dispose()
 for(const url of['https://magpie.test/?k=secret#providers','https://magpie.test/?q=providers#settings','https://magpie.test/?edit=a&edit=b','https://magpie.test/?view='+('x'.repeat(257)),'https://magpie.test/other#providers','https://attacker.test/#providers']){const g=setup();await tick();g.view.emit('dom-ready');await tick();g.view.url=url;g.view.emit('did-navigate',{url,httpResponseCode:200});g.view.emit('dom-ready');await tick();assert.equal(g.calls.length,0);assert.equal(g.view.scripts.length,0);assert.equal(g.states.at(-1)?.phase,'error');g.dispose()}
})
test('Magpie bootstrap UI history parameters permit only bounded unique view tab edit',async()=>{
 const url='https://magpie.test/?view=providers&edit=X&tab=usage#settings'
 const f=setup();await tick();f.view.emit('dom-ready');await tick()
 f.view.url=url;f.view.emit('did-navigate',{url:'https://magpie.test/',httpResponseCode:200});f.view.emit('did-navigate-in-page',{isMainFrame:true,url});f.view.emit('dom-ready');await tick()
 assert.deepEqual(f.calls,['issue','redeem']);assert.equal(f.view.scripts.length,1);assert.equal(f.states.at(-1)?.phase,'loading');f.dispose()
 for(const query of['k=secret','unknown=value','mode=window','import=x','q=x','view=a&view=b','tab=a&tab=b','edit=a&edit=b','view='+('x'.repeat(257))]){
  const g=setup();await tick();g.view.emit('dom-ready');await tick();g.view.url='https://magpie.test/?'+query;g.view.emit('did-navigate',{url:'https://magpie.test/',httpResponseCode:200});g.view.emit('dom-ready');await tick()
  assert.equal(g.calls.length,0);assert.equal(g.view.scripts.length,0);assert.equal(g.states.at(-1)?.phase,'error');g.dispose()
 }
})
test('in-place history after HTTP200 preserves page commitment before DOM-ready',async()=>{
 const f=setup();await submitted(f);commit(f.view)
 const url='https://magpie.test/?view=providers&edit=X&tab=usage';f.view.url=url
 f.view.emit('did-start-navigation',{isMainFrame:true,isInPlace:true,url});f.view.emit('did-navigate-in-page',{isMainFrame:true,url});f.view.emit('dom-ready');f.view.emit('did-stop-loading')
 assert.equal(f.states.at(-1)?.phase,'ready');assert.equal(f.calls.filter(x=>x==='issue').length,1);assert.equal(f.view.scripts.length,1);f.dispose()
})
test('in-page navigation cannot manufacture HTTP commitment and full navigation still clears it',async()=>{
 const f=setup();await submitted(f);f.view.url='https://magpie.test/?view=providers';f.view.emit('did-navigate-in-page',{isMainFrame:true,url:f.view.url});f.view.emit('dom-ready');assert.equal(f.states.at(-1)?.phase,'loading')
 commit(f.view);f.view.emit('dom-ready');assert.equal(f.states.at(-1)?.phase,'ready')
 f.view.emit('did-start-navigation',{isMainFrame:true,isInPlace:false,url:'https://magpie.test/next'});f.view.url='https://magpie.test/next';f.view.emit('did-navigate-in-page',{isMainFrame:true,url:f.view.url});f.view.emit('dom-ready');assert.equal(f.states.at(-1)?.phase,'loading')
 f.view.emit('did-navigate',{isMainFrame:true,url:f.view.url,httpResponseCode:200});f.view.emit('dom-ready');assert.equal(f.states.at(-1)?.phase,'ready');f.dispose()
 for(const url of['https://attacker.test/?view=providers','https://magpie.test/?k=secret']){const g=setup();await submitted(g);commit(g.view);g.view.url=url;g.view.emit('did-navigate-in-page',{isMainFrame:true,url});assert.equal(g.states.at(-1)?.phase,'error');g.dispose()}
})
test('redeemed descriptor must exactly match configured sign-in before any script receives credentials',async()=>{
 for(const url of['https://attacker.test/_magpie/sign-in','https://magpie.test/other/_magpie/sign-in','https://magpie.test/_magpie/sign-in?k=x','https://user@magpie.test/_magpie/sign-in','file:///tmp/_magpie/sign-in']){const f=setup({client:{launchRedeem:async()=>({url,body:'key=fake'})}});await signin(f);assert.equal(f.view.scripts.length,0);assert.equal(f.states.at(-1)?.phase,'error');assert.deepEqual(f.releases,['test-lease'])}
})
test('failed owner RPC/native script only return opaque errors; pending ticket revoked and false/200 result not accepted',async()=>{
 const f=setup({client:{launchRedeem:async()=>{throw new Error('private-secret')}}});await signin(f);assert.equal(f.states.at(-1)?.phase,'error');assert.deepEqual(f.revoked,['opaque-test-ticket']);assert.equal(JSON.stringify(f.states).includes('private-secret'),false)
 for(const execute of[async()=>false,async()=>({accepted:true}),async()=>{throw new Error('private-secret')}]){const view=new FakeView();view.execute=execute;const g=setup({view});await signin(g);assert.equal(g.states.at(-1)?.phase,'error');assert.equal(view.loads.length,1);assert.deepEqual(g.releases,['test-lease']);assert.equal(JSON.stringify(g.states).includes('private-secret'),false)}
})
test('startup timeout covers acquisition, issue, redeem and script, while ready clears deadline',async t=>{
 const scheduled=new Set<()=>void>();t.mock.method(globalThis,'setTimeout',((callback:()=>void,delay:number)=>{assert.equal(delay,30000);scheduled.add(callback);return callback})as unknown as typeof setTimeout);t.mock.method(globalThis,'clearTimeout',((id:()=>void)=>{scheduled.delete(id)})as unknown as typeof clearTimeout)
 const f=setup();await tick();assert.equal(scheduled.size,1);for(const callback of[...scheduled])callback();assert.equal(f.states.at(-1)?.phase,'error');assert.deepEqual(f.releases,['test-lease']);assert.equal(scheduled.size,0);assert.equal(f.view.listenerCount(),0)
 const g=setup();await submitted(g);commit(g.view);g.view.emit('did-stop-loading');assert.equal(g.states.at(-1)?.phase,'ready');assert.equal(scheduled.size,0);g.dispose()
})
test('creation failure releases lease, invalid configuration never acquires, expired token never redeems',async()=>{
 const releases:string[]=[];const states:NativeState[]=[];mountNativeView({appendChild(){}}as unknown as HTMLElement,{}as NativeLaunchClient,{managementUrl:'https://magpie.test',storageKey:'plugin-only',onState:state=>states.push(state),bridge:{acquire:async()=>({lease:'owned',partition:'isolated'}),release:async id=>{releases.push(id)}},createElement:()=>{throw new Error('secret')}});await tick();assert.deepEqual(releases,['owned']);assert.equal(states.at(-1)?.phase,'error');assert.equal(JSON.stringify(states).includes('secret'),false)
 const f=setup({managementUrl:'https://user@magpie.test'});await tick();assert.equal(f.acquisitions.length,0);assert.equal(f.states.at(-1)?.phase,'error')
 const g=setup({client:{launchIssue:async()=>({token:'expired',expiresAt:0})}});await signin(g);assert.equal(g.states.at(-1)?.phase,'error');assert.deepEqual(g.revoked,['expired']);assert.equal(g.view.scripts.length,0)
})
