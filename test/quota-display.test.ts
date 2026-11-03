import test from 'node:test'
import assert from 'node:assert/strict'
import type { QuotaAccountView, QuotaProviderView, QuotaWindowView } from '../src/contracts.ts'
import { aggregateQuota, aggregateWindowValue, compactBalance, compactCount, countdownLabel, isModelQuotaWindow, quotaHeadline, resetLabel, windowValue } from '../src/client/quota-display.ts'
const account = (windows: QuotaWindowView[], patch: Partial<QuotaAccountView> = {}): QuotaAccountView => ({ id:'account-1',label:'账号1',kind:'subscription',unavailable:false,stale:false,windows,...patch })
const provider = (...accounts: QuotaAccountView[]): QuotaProviderView => ({provider:'p',label:'P',accounts})

test('same-window percentages are averaged, unlike windows never mix, and compact periods show separate values not ranges',()=>{
 const p=provider(account([{kind:'percentage',label:'5h',remaining:20},{kind:'percentage',label:'7d',remaining:80}]),account([{kind:'percentage',label:'5h',remaining:60},{kind:'percentage',label:'7d',remaining:40}]))
 const q=aggregateQuota(p)
 assert.equal(q.windows.length,2)
 assert.equal(q.windows[0]!.remaining,40)
 assert.equal(q.windows[0]!.contributors,2)
 assert.equal(q.windows[0]!.aggregation,'mean')
 assert.equal(q.windows[1]!.remaining,60)
 assert.equal(quotaHeadline(p),'50%')
 assert.equal(aggregateWindowValue(q.windows[0]!),'平均剩余 40%')
 assert.ok(!quotaHeadline(p).includes('–'))
})
test('sum known used counts and totals before deriving remaining; never average differently sized known totals',()=>{
 const q=aggregateQuota(provider(account([{kind:'percentage',label:'Monthly',amount:20,limit:100,unit:'积分',remaining:80}]),account([{kind:'percentage',label:'Monthly',amount:180,limit:300,unit:'积分',remaining:40}])))
 assert.equal(q.windows[0]!.aggregation,'sum')
 assert.equal(q.windows[0]!.amount,200);assert.equal(q.windows[0]!.limit,400)
 assert.equal(q.windows[0]!.remaining,50)
 assert.equal(aggregateWindowValue(q.windows[0]!),'200 / 400 积分 已用')
 assert.equal(quotaHeadline(provider(account([{kind:'percentage',label:'Monthly',amount:20,limit:100}]))),'20/100')
})
test('mixed count and percent-only readings use equal-weight percent mean and do not invent total counts',()=>{
 const q=aggregateQuota(provider(account([{kind:'percentage',label:'5h',amount:20,limit:100}]),account([{kind:'percentage',label:'5h',remaining:40}])))
 assert.equal(q.windows[0]!.remaining,60)
 assert.equal(q.windows[0]!.aggregation,'mean')
 assert.equal(q.windows[0]!.amount,undefined);assert.equal(q.windows[0]!.limit,undefined)
})
test('unavailable accounts are excluded but cached eligible readings remain explicitly stale',()=>{
 const q=aggregateQuota(provider(account([{kind:'percentage',label:'5h',remaining:80}],{readAt:2000}),account([{kind:'percentage',label:'5h',remaining:0}],{unavailable:true,readAt:1000}),account([{kind:'percentage',label:'5h',remaining:40}],{stale:true,readAt:1500})))
 assert.equal(q.eligible,2);assert.equal(q.excluded,1);assert.equal(q.stale,true)
 assert.equal(q.readAt,1500);assert.equal(q.windows[0]!.remaining,60)
 assert.deepEqual(aggregateQuota(undefined),{windows:[],eligible:0,excluded:0,stale:false})
 assert.equal(quotaHeadline(provider(account([],{unavailable:true}))),'额度暂不可用')
})
test('balance windows sum only matching label unit and pool; malformed negative/nonfinite amounts are excluded',()=>{
 const q=aggregateQuota(provider(account([{kind:'balance',label:'Wallet',amount:20,unit:'积分'},{kind:'balance',label:'Wallet',amount:10,unit:'USD'},{kind:'balance',label:'Bad',amount:-1}]),account([{kind:'balance',label:'Wallet',amount:30,unit:'积分'},{kind:'balance',label:'Wallet',amount:40,unit:'积分',pool:'Other'},{kind:'balance',label:'Bad',amount:NaN}])))
 assert.equal(q.windows.length,3)
 assert.equal(q.windows[0]!.amount,50);assert.equal(q.windows[0]!.aggregation,'sum')
 assert.equal(aggregateWindowValue(q.windows[0]!),'合计 50 积分 剩余')
 assert.equal(q.windows[1]!.unit,'USD');assert.equal(q.windows[2]!.pool,'Other')
 assert.equal(q.stale,true)
})
test('duplicate same-account metric keys are omitted as ambiguous, never counted twice or arbitrarily picked',()=>{
 const q=aggregateQuota(provider(account([{kind:'percentage',label:'5h',remaining:10},{kind:'percentage',label:'5h',remaining:90},{kind:'percentage',label:'7d',remaining:50}]),account([{kind:'percentage',label:'5h',remaining:40}])))
 const five=q.windows.find(w=>w.label==='5h')!
 assert.equal(five.remaining,40);assert.equal(five.contributors,1);assert.equal(q.stale,true)
 assert.equal(q.windows.find(w=>w.label==='7d')!.remaining,50)
})
test('different reset times or incomplete reset reporting are not claimed as one reset; expiry is earliest known',()=>{
 const a=account([{kind:'percentage',label:'5h',remaining:40,resetsAt:2000,runsOutAt:3000},{kind:'percentage',label:'7d',remaining:50,resetsAt:5000}])
 const b=account([{kind:'percentage',label:'5h',remaining:60,resetsAt:2500,runsOutAt:2800},{kind:'percentage',label:'7d',remaining:70,resetsAt:5000}])
 const q=aggregateQuota(provider(a,b))
 assert.equal(q.windows[0]!.resetsAt,undefined);assert.equal(q.windows[0]!.resetVaries,true)
 assert.equal(q.windows[0]!.runsOutAt,2800)
 assert.equal(q.windows[1]!.resetsAt,5000);assert.equal(q.windows[1]!.resetVaries,undefined)
 b.windows[1]!.resetsAt=undefined
 assert.equal(aggregateQuota(provider(a,b)).windows[1]!.resetVaries,true)
})
test('text disagreement is a status, and unlimited cannot erase a finite metric with the same label',()=>{
 const q=aggregateQuota(provider(account([{kind:'text',label:'Sign-in',display:'已完成'},{kind:'unlimited',label:'Base'},{kind:'percentage',label:'Base',remaining:30}]),account([{kind:'text',label:'Sign-in',display:'未完成'},{kind:'unlimited',label:'Base'}])))
 assert.equal(q.windows[0]!.display,'状态不一致');assert.equal(q.windows[0]!.aggregation,'status')
 assert.equal(q.windows.filter(w=>w.label==='Base').length,2)
 assert.equal(q.windows.find(w=>w.kind==='percentage')!.remaining,30)
 assert.equal(q.windows.find(w=>w.kind==='unlimited')!.contributors,2)
})
test('unstructured balance strings are never guessed or added, and flagged shared balances are not summed',()=>{
 assert.equal(aggregateQuota(provider(account([],{balance:'12.5 credits'}))).balanceText,'12.5 credits')
 assert.equal(aggregateQuota(provider(account([],{balance:'12.5 credits'}),account([],{balance:'12.5 credits'}))).balanceText,'上游仅提供余额文本，无法可靠合计')
 const q=aggregateQuota(provider(account([{kind:'balance',label:'Wallet',amount:100,unit:'USD'}],{sharedBalance:true})))
 assert.equal(q.windows.length,0);assert.equal(q.balanceText,'上游余额由多个账号共享，无法可靠合计')
})
test('invalid metrics never emit nonfinite output; known zero remains a real reading',()=>{
 const q=aggregateQuota(provider(account([{kind:'percentage',label:'bad',remaining:NaN},{kind:'percentage',label:'bad-used',used:-1},{kind:'percentage',label:'zero',remaining:0},{kind:'balance',label:'infinite',amount:Infinity}])))
 assert.equal(q.windows.length,1);assert.equal(q.windows[0]!.remaining,0)
 assert.ok(!JSON.stringify(q).includes('null'))
})
test('countdown keeps the two largest units and ceils upward whenever a remainder exists',()=>{
 const min=(n:number)=>n*60_000
 assert.equal(countdownLabel(1000,0),'1m');assert.equal(countdownLabel(0,0),'0m');assert.equal(countdownLabel(-1,0),'0m')
 assert.equal(countdownLabel(min(0.5),0),'1m');assert.equal(countdownLabel(min(42),0),'42m')
 assert.equal(countdownLabel(min(60),0),'1h0m');assert.equal(countdownLabel(min(61),0),'1h1m')
 assert.equal(countdownLabel(min(121),0),'2h1m');assert.equal(countdownLabel(min(1439),0),'23h59m')
 assert.equal(countdownLabel(min(1440),0),'1d0h');assert.equal(countdownLabel(min(1559),0),'1d2h')
 assert.equal(countdownLabel(min(2880),0),'2d0h');assert.equal(countdownLabel(min(2881),0),'2d1h')
 assert.equal(countdownLabel(min(2879),0),'2d0h')
 assert.equal(countdownLabel(min(39133),0),'27d5h');assert.equal(countdownLabel(min(39121),0),'27d5h');assert.equal(countdownLabel(min(39120),0),'27d4h');assert.equal(countdownLabel(min(39119),0),'27d4h')
})
test('compact counts abbreviate magnitudes and balances keep their unit',()=>{
 assert.equal(compactCount(62440.54),'62.4k');assert.equal(compactCount(900),'900');assert.equal(compactCount(1000),'1k')
 assert.equal(compactCount(46668736),'46.7M');assert.equal(compactCount(987),'987');assert.equal(compactCount(12.5),'12.5');assert.equal(compactCount(0.47),'0.47')
 assert.equal(compactBalance('62440.54 credits'),'62.4k credits');assert.equal(compactBalance('12.5 credits'),'12.5 credits')
 assert.equal(compactBalance('1,234 tokens'),'1.23k tokens');assert.equal(compactBalance('上游仅提供余额文本，无法可靠合计'),undefined)
})
test('reset windows sort earliest first, expiry follows, and renamed free-token labels never leak into the pill',()=>{
 const now=1_000_000
 const min=(n:number)=>n*60_000
 const p=provider(account([
  {kind:'percentage',label:'Credits',remaining:91,amount:268.55,limit:3000,resetsAt:now+27*1440*min(1)},
  {kind:'percentage',label:'Extra credits',remaining:100,runsOutAt:now+2.5*1440*min(1)},
  {kind:'percentage',label:'deepseek-v4.1-flash tokens (est.)',remaining:88,resetsAt:now+22*60*min(1)}]))
 assert.equal(quotaHeadline(p,now),'22h0mR 88% · 27d0hR 91% · 2d12hL 100%')
 assert.equal(quotaHeadline(provider(account([{kind:'percentage',label:'5h',remaining:0,resetsAt:now-1}])),now),'0mR 0%')
 const codex=provider(account([{kind:'percentage',label:'7 days',remaining:26,resetsAt:now+172_860_000}],{balance:'62440.54 credits'}))
 assert.equal(quotaHeadline(codex,now),'2d1hR 26% · 62.4k credits')
})
test('permanent windows merge into one limit-weighted figure or a summed amount pair, balance-only shows the balance',()=>{
 const now=1_000_000
 const weighted=provider(account([{kind:'percentage',label:'Total credits',remaining:93,limit:500},{kind:'percentage',label:'Add-on credits',remaining:100,limit:200}]))
 assert.equal(quotaHeadline(weighted,now),'95%')
 const summed=provider(account([{kind:'percentage',label:'A',amount:900,limit:1000},{kind:'percentage',label:'B',amount:0,limit:400}]))
 assert.equal(quotaHeadline(summed,now),'0.9k/1.4k')
 assert.equal(quotaHeadline(provider(account([],{balance:'62440.54 credits'}))),'62.4k credits')
 assert.equal(quotaHeadline(provider(account([],{balance:'weird'}))),'查看额度')
})
test('countdown selects each window own reset and never the whole pool reset',()=>{
 const now=1000000
 const q=provider(account([{kind:'percentage',label:'7 天',remaining:80,resetsAt:now+60000},{kind:'percentage',label:'5 小时',remaining:20,resetsAt:now+8100000}]),account([{kind:'percentage',label:'7 天',remaining:60,resetsAt:now+60000},{kind:'percentage',label:'5 小时',remaining:60,resetsAt:now+9000000}]))
 assert.equal(quotaHeadline(q,now),'1mR 70% · 2h15mR 40%')
 const five=aggregateQuota(q).windows.find(w=>w.label==='5 小时')!
 assert.equal(five.resetsAt,undefined);assert.equal(five.resetVaries,true);assert.equal(five.nextResetAt,now+8100000)
 assert.equal(quotaHeadline(provider(account([{kind:'percentage',label:'Mystery',remaining:50,resetsAt:now+60000}])),now),'1mR 50%')
 assert.equal(quotaHeadline(provider(account([{kind:'percentage',label:'GLM-5.3-Flash-Trial · ZCODE GLOBAL BUILD',remaining:92}]))),'92%')
})
test('model display omits tool MCP search browser and ancillary quotas without changing inference cycles',()=>{
 for(const label of ['MCP · Month','MCP calls','工具调用','Web Search','browser credits','Code completions','每日签到','Image generation','视频生成'])assert.equal(isModelQuotaWindow({kind:'percentage',label}),false,label)
 for(const label of ['5h','7 天','Monthly','模型调用','Chat completions','Tokens','积分','加油包'])assert.equal(isModelQuotaWindow({kind:'percentage',label}),true,label)
 assert.equal(isModelQuotaWindow({kind:'percentage',label:'Month',pool:'MCP'}),false)
 const p=provider(account([{kind:'percentage',label:'5h',remaining:60},{kind:'percentage',label:'MCP · Month',remaining:99},{kind:'balance',label:'Search',amount:1000},{kind:'text',label:'每日签到',display:'已领取'}]))
 assert.deepEqual(aggregateQuota(p).windows.map(w=>w.label),['5h'])
 assert.equal(quotaHeadline(p),'60%')
 const tools=provider(account([{kind:'percentage',label:'MCP · Month',remaining:100}],{balance:'100 tool credits'}))
 assert.equal(quotaHeadline(tools),'暂无额度读数');assert.equal(aggregateQuota(tools).balanceText,undefined)
})
test('value and reset helpers retain correct remaining/count/text distinctions',()=>{
 assert.equal(windowValue({kind:'text',label:'Check-in',display:'未签到'}),'未签到')
 assert.equal(windowValue({kind:'balance',label:'Wallet',amount:2500,unit:'积分'}),'2,500 积分 剩余')
 assert.equal(windowValue({kind:'unlimited',label:'Base'}),'不限量')
 assert.equal(windowValue({kind:'percentage',label:'Monthly',remaining:70,amount:300,limit:1000,unit:'积分'}),'300 / 1,000 积分 已用')
 assert.equal(quotaHeadline(undefined),'暂无额度读数')
 assert.equal(resetLabel(1000,2000),'等待更新')
 assert.equal(resetLabel(3600000,0),'1 小时 0 分后重置')
})
