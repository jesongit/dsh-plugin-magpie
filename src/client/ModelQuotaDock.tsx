import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import type { MagpieClient } from './state.ts'
import type { ModelSelectionSource } from './model-selection.ts'
import { selectedMagpieGroup } from './model-selection.ts'
import { aggregateQuota, aggregateWindowValue, quotaHeadline, resetLabel } from './quota-display.ts'
import type { AggregatedWindow } from './quota-display.ts'
import { MagpieIcon } from './components.tsx'

export interface ModelQuotaDockProps { client: MagpieClient; selection: ModelSelectionSource }
export function ModelQuotaDock({ client, selection }: ModelQuotaDockProps) {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
  const model = useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot)
  const group = selectedMagpieGroup(model, snapshot.status)
  const [clock, setClock] = useState(Date.now)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const key = group && model ? `${model.provider}\n${model.model}` : null
  const open = key !== null && openKey === key
  const quota = snapshot.quota
  const provider = group ? quota?.providers?.find(value => value.provider === group.upstream) : undefined
  // Merged values are pure per provider snapshot; memo keeps renders off the aggregation path.
  const merged = useMemo(() => aggregateQuota(provider), [provider])
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const sourceKey = group?.upstream
  useEffect(() => { void client.read() }, [client])
  useEffect(() => {
    if (!sourceKey) return
    setClock(Date.now())
    void client.quotas()
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') { setClock(Date.now()); void client.quotas() } }, 60_000)
    // Re-sync the countdown the moment the window becomes visible again.
    const visible = () => { if (document.visibilityState !== 'hidden') { setClock(Date.now()); void client.quotas() } }
    document.addEventListener('visibilitychange', visible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [client, sourceKey])
  useEffect(() => { setOpenKey(null) }, [key])
  useLayoutEffect(() => {
    if (!open) return
    let frame: number | undefined
    const measure = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      const box = panel.current?.getBoundingClientRect()
      if (!anchor || !box) return
      const margin = 12, gap = 8
      const left = Math.max(margin, Math.min(anchor.left, innerWidth - box.width - margin))
      const above = anchor.top - box.height - gap
      const top = above >= margin ? above : Math.min(anchor.bottom + gap, Math.max(margin, innerHeight - box.height - margin))
      setPosition({ left, top, visibility: 'visible' })
    }
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; measure() }) }
    measure()
    const observer = new ResizeObserver(schedule)
    if (panel.current) observer.observe(panel.current)
    // The trigger can move without resizing (sidebar animation); its parent
    // catches sibling-driven moves, and transitionend lands the final frame.
    if (trigger.current) observer.observe(trigger.current)
    if (trigger.current?.parentElement) observer.observe(trigger.current.parentElement)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    document.addEventListener('transitionend', schedule, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); document.removeEventListener('transitionend', schedule, true); if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [open])
  useEffect(() => {
    if (!open) return
    panel.current?.focus({ preventScroll: true })
    const close = () => { setOpenKey(null); trigger.current?.focus({ preventScroll: true }) }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) { setOpenKey(null); trigger.current?.focus({ preventScroll: true }) }
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
    }
    const focusOutside = (event: FocusEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) { setOpenKey(null); trigger.current?.focus({ preventScroll: true }) } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', keyboard)
    document.addEventListener('focusin', focusOutside)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard); document.removeEventListener('focusin', focusOutside) }
  }, [open])
  if (!group || !model) return null
  const stale = quota?.stale || merged.stale
  const headline = !quota ? '读取额度…' : quota.error && !provider ? '额度暂不可用' : quotaHeadline(provider, clock)
  const close = () => { setOpenKey(null); trigger.current?.focus() }
  return <span className="dsh-magpie mp-model-quota">
    <button ref={trigger} type="button" className="mp-quota-pill" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} title="合并额度；倒计时为最短周期内的下一次重置，百分比为该窗口的合计或等权平均值" onClick={() => { setPosition({ visibility: 'hidden' }); setOpenKey(open ? null : key); if (!open) void client.quotas() }}><MagpieIcon size={13} /><span>{group.name.replace(/^Magpie\s*[·・—-]\s*/i, '')} · {headline}{stale ? ' · 缓存' : ''}</span></button>
    {open && createPortal(<div ref={panel} id={id} className="dsh-magpie mp-quota-dialog" role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} tabIndex={-1} style={position}>
      <div className="mp-quota-title"><span id={`${id}-title`}><MagpieIcon size={15} />{group.name}</span><button type="button" onClick={close} aria-label="关闭额度弹窗">关闭</button></div>
      <div className="mp-quota-model">{model.model}</div>
      <p className="mp-quota-scope">供应商合并额度 · 已排除异常账号；不同额度窗口分别统计，不代表此模型独占额度。</p>
      {quota?.error && <p className="mp-quota-notice" role="status">暂时无法更新额度。{provider ? '以下为上次读数。' : '不影响模型调用。'}</p>}
      {!quota ? <p role="status">正在读取 Magpie 已缓存的额度…</p> : !provider?.accounts.length ? <p role="status">Magpie 尚未提供此供应商的额度读数。路由组或转发服务可能不提供独立额度。</p> : !merged.eligible ? <p role="status">暂无可合并的正常额度，异常账号已排除。</p> : <section className="mp-quota-account" aria-label="合并额度">
        {merged.excluded > 0 && <p className="mp-quota-notice">已排除 {merged.excluded} 个异常账号</p>}
        {merged.balanceText && <div className="mp-quota-line"><span>余额</span><span>{merged.balanceText}</span></div>}
        {merged.windows.map((window,index) => <QuotaWindow key={index} window={window} />)}
        {merged.windows.some(window => window.aggregation === 'mean') && <p className="mp-quota-notice">未提供总量的窗口按正常读数等权平均；百分比不是可相加的额度。</p>}
        {!merged.windows.length && !merged.balanceText && <p className="mp-quota-notice">暂无可合并的同类读数</p>}
        {merged.readAt && <div className="mp-quota-time">最早读数 {new Date(merged.readAt).toLocaleString()}{merged.stale ? ' · 缓存' : ''}</div>}
      </section>}
      <div className="mp-quota-footer"><span>{quota?.updatedAt ? `缓存同步 ${new Date(quota.updatedAt).toLocaleTimeString()}` : '仅读取 Magpie 的现有快照'}</span><button type="button" onClick={() => { void client.quotas() }}>更新快照</button></div>
    </div>, document.body)}
  </span>
}
function QuotaWindow({ window }: { window: AggregatedWindow }) {
  const remaining = window.remaining ?? 0
  return <div className="mp-quota-window">
    <div className="mp-quota-line"><span>{window.label}{window.pool ? ` · ${window.pool}` : ''}</span><span>{aggregateWindowValue(window)}</span></div>
    {window.kind === 'percentage' && <div className="mp-quota-bar" role="meter" aria-label={`${window.label}剩余`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}><div style={{ width: `${remaining}%`, background: remaining < 10 ? 'var(--dsw-alias-state-error-primary)' : remaining < 25 ? 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))' : 'var(--dsw-alias-state-business-primary)' }} /></div>}
    {(window.resetVaries || window.resetsAt || window.runsOutAt) && <div className="mp-quota-time">{window.resetVaries ? '按各自时间重置' : resetLabel(window.resetsAt)}{window.runsOutAt ? ` · 最早到期 ${new Date(window.runsOutAt).toLocaleDateString()}` : ''}</div>}
  </div>
}
