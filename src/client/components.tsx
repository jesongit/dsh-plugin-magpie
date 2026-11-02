import { MAGPIE_PATH } from './icon.ts'
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { StatusView } from '../contracts.ts'
import type { MagpieClient } from './state.ts'
import { ManagementAnchor } from './NativeManagement.tsx'
import type { RetainedSurface } from './retained-surface.ts'

export interface Injected { client: MagpieClient; open: () => void }
export function MagpieIcon({ size = 18 }: { size?: number }) {
  // Original Magpie small-size silhouette, MIT © 2026 yetone; see THIRD-PARTY-NOTICES.
  return <svg width={size} height={size} viewBox="0 0 44 44" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d={MAGPIE_PATH} /></svg>
}
function useClient(client: MagpieClient) {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
  useEffect(() => { void client.read() }, [client])
  return snapshot
}
export function ConnectionStatus({ status }: { status: StatusView | null }) {
  const label = !status ? '读取连接状态…' : !status.configured ? '尚未连接' : status.connected ? status.stale ? '使用上次同步的目录' : '已连接' : '连接需要检查'
  return <span className="mp-status" role="status"><i className="mp-dot" data-online={status?.connected && !status.stale} />{label}</span>
}
export function ConnectionForm({ client, open }: Injected) {
  const { status, busy, error } = useClient(client)
  const prefix = useId()
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [gatewayKey, setGatewayKey] = useState('')
  const [create, setCreate] = useState(false)
  const [touched, setTouched] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  useEffect(() => { if (status && !touched) { setUrl(status.url); setGatewayUrl(status.gatewayUrl) } }, [status, touched])
  const sameUrl = Boolean(status?.configured && url.replace(/\/$/, '') === status.url.replace(/\/$/, ''))
  const valid = Boolean(url.trim() && (key.trim() || (sameUrl && status?.hasLoginKey)))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!valid || busy) return
    const success = await client.connect({ url: url.trim(), loginKey: key, createGatewayKey: create,
      ...(gatewayUrl.trim() ? { gatewayUrl: gatewayUrl.trim() } : {}),
      ...(gatewayKey.trim() ? { gatewayKey: gatewayKey.trim() } : {}) })
    if (success) { setKey(''); setGatewayKey(''); setCreate(false); setTouched(false) }
  }
  return <div className="dsh-magpie"><div className="mp-form">
    <h2>连接 Magpie</h2>
    <p className="mp-muted">自动同步模型，按 Codex、WorkBuddy 等供应商分组。账号轮询、额度与故障回退继续由 Magpie 管理。</p>
    <ConnectionStatus status={status} />
    <form onSubmit={event => { void submit(event) }}>
      <div className="mp-field"><label htmlFor={`${prefix}-url`}>后台 URL</label><input id={`${prefix}-url`} type="url" required value={url} disabled={busy} placeholder="http://127.0.0.1:3430" onChange={e => { setTouched(true); setUrl(e.target.value); setGatewayUrl(''); setGatewayKey('') }} autoComplete="url" /><span className="mp-muted">填写能打开 Magpie 管理页面的地址，不是仅提供模型接口的网关地址。</span></div>
      <div className="mp-field"><label htmlFor={`${prefix}-key`}>后台登录密钥</label><input id={`${prefix}-key`} type="password" value={key} disabled={busy} required={!sameUrl || !status?.hasLoginKey} placeholder={sameUrl && status?.hasLoginKey ? '已保存在本机；留空继续使用' : '填写 Magpie 后台登录密钥'} autoComplete="off" onChange={e => setKey(e.target.value)} /><span className="mp-muted">密钥保存在 DSH 本机插件数据，自动登录时仅用于 POST 提交，不放入页面 URL 或模型上下文。</span></div>
      <details><summary>高级连接设置</summary><div className="mp-field"><label htmlFor={`${prefix}-gateway`}>网关 URL（可选）</label><input id={`${prefix}-gateway`} type="url" value={gatewayUrl} disabled={busy} placeholder="自动发现；远程连接时可手动指定" onChange={e => setGatewayUrl(e.target.value)} /></div><div className="mp-field"><label htmlFor={`${prefix}-gateway-key`}>已有网关 API Key（可选）</label><input id={`${prefix}-gateway-key`} type="password" value={gatewayKey} disabled={busy} placeholder="使用已有 Key，可不创建新 Key" autoComplete="off" onChange={e => setGatewayKey(e.target.value)} /></div></details>
      <label className="mp-check"><input type="checkbox" checked={create} disabled={busy} onChange={e => setCreate(e.target.checked)} /><span>允许在 Magpie 创建一个 DSH 专用网关 Key<span className="mp-muted" style={{ display: 'block' }}>该 Key 可调用模型并消耗额度；插件不会开启网络共享。已有连接通常无需再次创建。</span></span></label>
      {!status?.hasGatewayKey && !gatewayKey && !create && <p className="mp-muted">首次连接请选择创建专用 Key，或在高级设置填写已有网关 Key。</p>}
      <div className="mp-actions"><button type="submit" className="mp-primary" disabled={busy || !valid}>{busy ? '正在处理…' : '连接并同步模型'}</button>{status?.configured && <><button type="button" disabled={busy} onClick={() => { void client.refresh() }}>刷新模型</button><button type="button" disabled={busy} onClick={open}>打开后台</button></>}</div>
    </form>
    {(error || status?.error) && <p className="mp-message mp-error" role="alert">{error || status?.error}</p>}
    {status?.configured && <><h3>已同步的供应商</h3><p className="mp-muted">{status.modelCount} 个模型 · {status.groups.length} 个分组{status.version ? ` · Magpie ${status.version}` : ''}{status.syncedAt ? ` · ${new Date(status.syncedAt).toLocaleTimeString()} 同步` : ''}</p><ul className="mp-directory">{status.groups.map(group => <li key={group.route}><span>{group.name}</span><span className="mp-muted">{group.models} 个模型</span></li>)}</ul>
    {confirmDisconnect ? <div className="mp-message"><p>断开后将移除此插件的模型分组和本机保存的密钥，不修改已有手工配置。已创建的网关 Key 不会自动删除，可在 Magpie 中撤销。</p><div className="mp-actions"><button type="button" className="mp-danger" disabled={busy} onClick={() => { void client.disconnect().then(ok => { if (ok) { setConfirmDisconnect(false); setTouched(false); setUrl(''); setGatewayUrl('') } }) }}>确认断开</button><button type="button" disabled={busy} onClick={() => setConfirmDisconnect(false)}>取消</button></div></div> : <button type="button" className="mp-danger" disabled={busy} onClick={() => setConfirmDisconnect(true)}>断开连接…</button>}</>}
  </div></div>
}
export function MagpieSettings(props: Injected & PropsRuntime<'settings.section'>) { return <ConnectionForm client={props.client} open={() => { props.close(); props.open() }} /> }

export function MagpiePanel({ client, open, surface }: Injected & { surface: RetainedSurface }) {
  const { status, error } = useClient(client)
  const ready = Boolean(status?.configured && status.url && status.hasLoginKey)
  return <div className="dsh-magpie" style={{ height: '100%' }}><section className="mp-panel" aria-label="Magpie 后台">
    {!status ? <div className="mp-body"><p role="status">{error ?? '正在读取连接设置…'}</p></div> : !ready ? <div className="mp-body"><p className="mp-message">先填写 Magpie 后台 URL 和登录密钥，连接成功后即可打开原版后台。</p><ConnectionForm client={client} open={open} /></div> : <ManagementAnchor surface={surface} />}
  </section></div>
}

