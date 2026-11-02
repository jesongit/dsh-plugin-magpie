import { MAGPIE_PATH } from './icon.ts'

/** rc.5 settings has a closed icon map: adapt only our exact row, never the host bundle. */
export function installSettingsIcon(): () => void {
  const selector = '[role="dialog"][data-shortcut-modal="settings"] nav button'
  const marker = 'data-dsh-magpie-settings-icon'
  const installed = new Map<SVGElement, { path: SVGPathElement; children: Node[]; viewBox: string | null; fill: string | null }>()
  let disposed = false
  let frame: number | undefined
  function restore(icon: SVGElement): void {
    const original = installed.get(icon)
    if (!original) return
    // If another owner already replaced the icon, do not overwrite that update.
    if (icon.contains(original.path)) {
      icon.replaceChildren(...original.children)
      if (original.viewBox === null) icon.removeAttribute('viewBox'); else icon.setAttribute('viewBox', original.viewBox)
      if (original.fill === null) icon.removeAttribute('fill'); else icon.setAttribute('fill', original.fill)
    }
    icon.removeAttribute(marker)
    installed.delete(icon)
  }
  function sync(): void {
    if (disposed) return
    const wanted = new Set<SVGElement>()
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>(selector))) {
      if (button.textContent?.trim() !== 'Magpie') continue
      const icon = button.querySelector<SVGElement>(':scope > svg')
      if (!icon) continue // Future shell structure: fail closed, retain its icon.
      wanted.add(icon)
      if (installed.has(icon)) continue
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', MAGPIE_PATH)
      path.setAttribute('fill-rule', 'evenodd')
      path.setAttribute('fill', 'currentColor')
      installed.set(icon, { path, children: Array.from(icon.childNodes), viewBox: icon.getAttribute('viewBox'), fill: icon.getAttribute('fill') })
      icon.setAttribute('viewBox', '0 0 44 44')
      icon.setAttribute('fill', 'currentColor')
      icon.setAttribute(marker, '')
      icon.replaceChildren(path)
    }
    for (const icon of installed.keys()) if (!wanted.has(icon)) restore(icon)
  }
  const observer = new MutationObserver(records => {
    // Ignore conversation streaming. Inspect only settings subtrees or dialog mount/unmount.
    if (!records.some(record => record.target instanceof Element && record.target.closest('[data-shortcut-modal="settings"]') || [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(node => node instanceof Element && (node.matches('[data-shortcut-modal="settings"]') || node.querySelector('[data-shortcut-modal="settings"]'))))) return
    if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; sync() })
  })
  sync()
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    disposed = true
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
    for (const icon of installed.keys()) restore(icon)
  }
}
