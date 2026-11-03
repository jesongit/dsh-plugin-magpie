import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PanelInfo, UsePanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MagpieClient } from './state.ts'
import type { RetainedSurface } from './retained-surface.ts'
import { mountNativeView, nativeBridge } from './native-view.ts'

const partitionScope = `dsh-magpie-management:${Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')}`
/** This component lives only in shell.overlay, never under the transient main panel. */
export function NativeManagement({ client, url }: { client: MagpieClient; url: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const bridge = nativeBridge()
  useEffect(() => {
    if (!host.current || !bridge) return
    setFailure(null)
    return mountNativeView(host.current, client, {
      managementUrl: url, storageKey: `${partitionScope}:${url}`, bridge,
      onState: state => { if (state.phase === 'error') setFailure(state.error) },
      // The host's main-window window-open policy sends http(s) to the system
      // browser and denies new windows, so a link click costs no extra webview.
      openExternal: target => { try { window.open(target, '_blank', 'noopener') } catch { /* host policy refuses */ } }
    })
  }, [client, url, bridge, revision])
  if (!bridge) return <div className="mp-body"><p role="status">请在 DSH 桌面窗口打开 Magpie 后台。</p></div>
  return <div className="mp-native-surface">
    {failure && <div className="mp-native-failure" role="alert"><p>{failure}</p><button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
    <div ref={host} className="mp-native-host" aria-label="Magpie 原生管理后台" />
  </div>
}

export interface SurfaceProps { client: MagpieClient; surface: RetainedSurface }
export function RetainedManagement({ client, surface, usePanelInfo }: SurfaceProps & { usePanelInfo: UsePanelInfo }) {
  const snapshot = useSyncExternalStore(surface.subscribe, surface.getSnapshot, surface.getSnapshot)
  const active = usePanelInfo((panel: PanelInfo) => panel.activePanelId === 'magpie')
  const element = useRef<HTMLDivElement>(null)
  const bounds = snapshot.bounds
  const visible = active && bounds !== null && snapshot.activated && snapshot.url !== null
  useLayoutEffect(() => {
    const node = element.current
    if (!node) return
    // A hidden guest must not retain keyboard focus or remain reachable by tab navigation.
    node.inert = !visible
    if (!visible && node.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur?.()
  }, [visible])
  return <div ref={element} className="dsh-magpie mp-retained-management" aria-hidden={!visible}
    style={{ display: visible ? 'flex' : 'none', pointerEvents: visible ? 'auto' : 'none', left: bounds?.left ?? 0, top: bounds?.top ?? 0, width: bounds?.width ?? 0, height: bounds?.height ?? 0 }}>
    {snapshot.activated && snapshot.url && <NativeManagement key={`${snapshot.generation}:${snapshot.url}`} client={client} url={snapshot.url} />}
  </div>
}

/** Empty geometry anchor only: its disposal hides the retained guest, never detaches its DOM. */
export function ManagementAnchor({ surface }: { surface: RetainedSurface }) {
  const element = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = element.current
    if (!node) return
    const owner = {}
    surface.attach(owner)
    const measure = () => {
      const rect = node.getBoundingClientRect()
      surface.setBounds(owner, { left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    }
    let frame: number | undefined
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; measure() }) }
    measure()
    const observer = new ResizeObserver(schedule)
    observer.observe(node)
    // Sibling width drags may move the anchor without resizing it. Parent observation catches that.
    if (node.parentElement) observer.observe(node.parentElement)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    // The frame's sidebar animation changes position every frame; ResizeObserver catches size,
    // transition completion ensures the final left edge is exact even for fixed-width moves.
    document.addEventListener('transitionend', schedule, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      document.removeEventListener('transitionend', schedule, true)
      if (frame !== undefined) cancelAnimationFrame(frame)
      surface.detach(owner)
    }
  }, [surface])
  return <div ref={element} className="mp-management-anchor" aria-hidden="true" />
}
