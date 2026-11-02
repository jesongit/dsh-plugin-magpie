import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MagpieClient } from './state.ts'
import type { ModelSelectionSource } from './model-selection.ts'

export interface SpeedSelectProps { client: MagpieClient; selection: ModelSelectionSource; sessionId: string }
interface SpeedState { tier: 'standard' | 'fast'; visible: boolean }

/**
 * Codex speed toggle beside the model selector: standard/fast only when the
 * current Magpie model advertises the priority service tier. The SDK's model
 * store observable pushes model switches instantly (3s poll only as a
 * legacy-host fallback); a failed RPC keeps the last known state instead of
 * hiding the control.
 */
export function SpeedSelect({ client, selection, sessionId }: SpeedSelectProps) {
  const [state, setState] = useState<SpeedState | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  // The SDK store pushes on every model switch; useSyncExternalStore re-renders
  // this component the moment the selection changes, no polling wait.
  const model = useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot)
  // Re-evaluate visibility the instant the model switches; the poll below is
  // only a fallback for hosts whose model service has no observable.
  useEffect(() => {
    let cancelled = false
    let inflight = false
    const reload = (): void => {
      if (inflight) return
      inflight = true
      void client.speed(sessionId, model?.provider ?? '', model?.model ?? '')
        .then(value => { if (!cancelled) setState({ tier: value.tier, visible: value.visible }) })
        .catch(() => { /* keep last known state; next tick retries */ })
        .finally(() => { inflight = false })
    }
    reload()
    const timer = setInterval(reload, 3000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [client, sessionId, model])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const keyboard = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard) }
  }, [open])
  if (!state?.visible) return null
  const choose = (tier: 'standard' | 'fast'): void => {
    if (busy || tier === state.tier) { setOpen(false); return }
    setBusy(true)
    void client.setSpeed(sessionId, tier).then(() => { setState({ visible: true, tier }); setOpen(false) })
      .catch(() => { /* the next poll re-reads the authoritative tier */ })
      .finally(() => setBusy(false))
  }
  return <span ref={root} className="dsh-magpie mp-speed" aria-haspopup="menu" aria-expanded={open}>
    <button type="button" className="mp-speed-trigger" onClick={() => setOpen(value => !value)} aria-label="Magpie 速度 · 当前速度" title="Magpie 速度 · 当前速度">
      {state.tier === 'fast' ? '快速' : '标准'}
    </button>
    {open && <div className="mp-speed-menu" role="menu" aria-label="Magpie 速度">
      <button type="button" role="menuitemradio" aria-checked={state.tier === 'standard'} disabled={busy} onClick={() => choose('standard')}><span className="mp-speed-item"><span className="mp-speed-name">标准</span><span className="mp-speed-desc">默认速度</span></span>{state.tier === 'standard' && <span className="mp-speed-check" aria-hidden="true">✓</span>}</button>
      <button type="button" role="menuitemradio" aria-checked={state.tier === 'fast'} disabled={busy} onClick={() => choose('fast')}><span className="mp-speed-item"><span className="mp-speed-name">快速</span><span className="mp-speed-desc">约 1.5 倍速度，消耗更多用量</span></span>{state.tier === 'fast' && <span className="mp-speed-check" aria-hidden="true">✓</span>}</button>
    </div>}
  </span>
}
