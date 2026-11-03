import type { QuotaProviderView, QuotaWindowView } from '../contracts.ts'

export interface AggregatedWindow extends QuotaWindowView {
  contributors: number
  aggregation: 'mean' | 'sum' | 'status'
  resetVaries?: boolean
  /** Earliest known member reset for compact countdown only; never a claim that the whole pool resets then. */
  nextResetAt?: number
}
export interface AggregatedQuota {
  windows: AggregatedWindow[]
  eligible: number
  excluded: number
  stale: boolean
  readAt?: number
  balanceText?: string
}
const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value)
const validTime = (value: number | undefined): value is number => finite(value) && value > 0
const share = (window: QuotaWindowView): number | undefined => finite(window.remaining) && window.remaining >= 0 && window.remaining <= 100 ? window.remaining
  : finite(window.used) && window.used >= 0 && window.used <= 100 ? 100 - window.used
    : finite(window.amount) && window.amount >= 0 && finite(window.limit) && window.limit > 0 ? Math.max(0, Math.min(100, 100 * (1 - window.amount / window.limit))) : undefined
function metricKey(window: QuotaWindowView): string { return JSON.stringify([window.kind, window.label, window.pool ?? '', window.unit ?? '']) }

/** The gateway report has no model-scope field: remove explicit non-inference buckets, never guess from a model brand. */
export function isModelQuotaWindow(window: QuotaWindowView): boolean {
  const scope = `${window.label} ${window.pool ?? ''} ${window.unit ?? ''}`.normalize('NFKC')
  return !/(?:\bmcp\b|\btools?\b|tool[ _-]?(?:calls?|usage|quota|credits?)|\b(?:web[ _-]?)?search\b|\bbrowsers?\b|\bcode[ _-]?completions?\b|\b(?:image|video|audio)[ _-]?(?:generation|credits?|quota|minutes?)?\b|\bcheck[ _-]?in\b|工具|搜索|搜尋|浏览器|瀏覽器|代码补全|代碼補全|签到|簽到|图像生成|圖片生成|视频生成|音频)/i.test(scope)
}

/** Same window only, never percentages across different windows or different units/pools. */
export function aggregateQuota(provider: QuotaProviderView | undefined): AggregatedQuota {
  const accounts = provider?.accounts ?? []
  const eligible = accounts.filter(account => !account.unavailable)
  const result: AggregatedQuota = { windows: [], eligible: eligible.length, excluded: accounts.length - eligible.length, stale: eligible.some(account => account.stale) }
  const readings = eligible.map(account => account.readAt).filter(validTime)
  if (readings.length) result.readAt = Math.min(...readings)
  const balances = eligible.filter(account => typeof account.balance === 'string' && account.balance.trim() && isModelQuotaWindow({ kind: 'text', label: account.balance }))
  // One account's wallet text is not the provider's balance when other accounts report none.
  if (balances.length === eligible.length && eligible.length > 0) result.balanceText = eligible.length === 1 ? balances[0]!.balance! : '上游仅提供余额文本，无法可靠合计'
  const groups = new Map<string, QuotaWindowView[]>()
  for (const account of eligible) {
    // Ambiguous duplicates in one account are omitted altogether, not summed or arbitrarily selected.
    const own = new Map<string, QuotaWindowView[]>()
    for (const window of account.windows) {
      if (!isModelQuotaWindow(window)) continue
      const key = metricKey(window)
      const items = own.get(key) ?? []
      items.push(window)
      own.set(key, items)
    }
    for (const [key, items] of own) {
      if (items.length !== 1) { result.stale = true; continue }
      const window = items[0]!
      if (window.kind === 'percentage' && share(window) === undefined && !(finite(window.amount) && window.amount >= 0 && finite(window.limit) && window.limit > 0)) { result.stale = true; continue }
      if (window.kind === 'balance' && account.sharedBalance) {
        result.balanceText = '上游余额由多个账号共享，无法可靠合计'
        continue
      }
      if (window.kind === 'balance' && (!finite(window.amount) || window.amount < 0)) { result.stale = true; continue }
      const group = groups.get(key) ?? []
      group.push(window)
      groups.set(key, group)
    }
  }
  for (const windows of groups.values()) {
    const first = windows[0]!
    const base: AggregatedWindow = {
      kind: first.kind, label: first.label, contributors: windows.length, aggregation: 'status',
      ...(first.unit === undefined ? {} : { unit: first.unit }), ...(first.pool === undefined ? {} : { pool: first.pool })
    }
    const resets = windows.map(window => window.resetsAt)
    const knownResets = resets.filter(validTime)
    if (knownResets.length) base.nextResetAt = Math.min(...knownResets)
    if (resets.every(value => value === undefined)) { /* no reset supplied */ }
    else if (validTime(resets[0]) && resets.every(value => value === resets[0])) base.resetsAt = resets[0]
    else base.resetVaries = true
    const expiry = windows.map(window => window.runsOutAt).filter(validTime)
    if (expiry.length) base.runsOutAt = Math.min(...expiry)
    if (first.kind === 'percentage') {
      const counted = windows.every(window => finite(window.amount) && window.amount >= 0 && finite(window.limit) && window.limit > 0)
      if (counted) {
        const amount = windows.reduce((sum, window) => sum + window.amount!, 0)
        const limit = windows.reduce((sum, window) => sum + window.limit!, 0)
        if (!Number.isFinite(amount) || !Number.isFinite(limit) || limit <= 0) { result.stale = true; continue }
        base.amount = amount; base.limit = limit
        base.remaining = Math.max(0, Math.min(100, 100 * (1 - amount / limit)))
        base.used = 100 - base.remaining
        base.aggregation = 'sum'
      } else {
        const shares = windows.map(share).filter((value): value is number => value !== undefined)
        if (!shares.length) { result.stale = true; continue }
        base.contributors = shares.length
        base.remaining = shares.reduce((sum, value) => sum + value, 0) / shares.length
        base.used = 100 - base.remaining
        base.aggregation = 'mean'
        // A uniform reported limit is retained for weighted merging; differing ones are never invented.
        const limits = windows.map(window => finite(window.limit) && window.limit > 0 ? window.limit : undefined)
        const uniform = limits[0]
        if (uniform !== undefined && limits.every(value => value === uniform)) base.limit = uniform
        if (shares.length !== windows.length) result.stale = true
      }
    } else if (first.kind === 'balance') {
      const amount = windows.reduce((sum, window) => sum + window.amount!, 0)
      if (!Number.isFinite(amount)) { result.stale = true; continue }
      base.amount = amount; base.aggregation = 'sum'
    } else if (first.kind === 'text') {
      const displays = new Set(windows.map(window => window.display || '未提供数值'))
      base.display = displays.size === 1 ? [...displays][0]!.slice(0, 160) : '状态不一致'
    }
    result.windows.push(base)
  }
  return result
}
export function windowValue(window: QuotaWindowView): string {
  if (window.kind === 'unlimited') return '不限量'
  if (window.kind === 'text') return window.display || '未提供数值'
  if (window.kind === 'balance') return `${number(window.amount ?? 0)}${window.unit ? ` ${window.unit}` : ''} 剩余`
  if (window.amount !== undefined && window.limit !== undefined && window.limit > 0) return `${number(window.amount)} / ${number(window.limit)}${window.unit ? ` ${window.unit}` : ''} 已用`
  return `${Math.round(window.remaining ?? 0)}% 剩余`
}
export function aggregateWindowValue(window: AggregatedWindow): string {
  if (window.kind === 'percentage') {
    if (finite(window.amount) && finite(window.limit) && window.limit > 0) return `${number(window.amount)} / ${number(window.limit)}${window.unit ? ` ${window.unit}` : ''} 已用`
    return `${window.aggregation === 'mean' && window.contributors > 1 ? '平均' : window.aggregation === 'sum' ? '合计' : ''}剩余 ${Math.round(window.remaining ?? 0)}%`
  }
  if (window.kind === 'balance') return `合计 ${windowValue(window)}`
  return windowValue(window)
}
function number(value: number): string { return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value) }
/** Countdown keeps the two largest units and ceils upward whenever a remainder exists. */
export function countdownLabel(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= now) return '0m'
  const minutes = Math.ceil((at - now) / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) {
    const carried = hours + (rest > 0 ? 1 : 0)
    return carried >= 24 ? `${days + 1}d0h` : `${days}d${carried}h`
  }
  return hours > 0 ? `${hours}h${rest}m` : `${rest}m`
}
/** Compact magnitude: 62.4k, 0.9k, 46.7M, 12.5; below the suffix thresholds stay exact. */
export function compactCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  const scale = abs >= 1e9 ? [1e9, 'B'] as const : abs >= 1e6 ? [1e6, 'M'] as const : abs >= 1000 ? [1000, 'k'] as const : [1, ''] as const
  return compactScaled(value, scale[0]) + scale[1]
}
function compactScaled(value: number, divisor: number): string {
  let text = (value / divisor).toPrecision(3)
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  return text
}
const BALANCE_TEXT = /^([0-9][\d,]*(?:\.[0-9]+)?)\s*(\S.*)$/
/** A balance like "62440.54 credits" becomes "62.4k credits"; anything unparsable stays hidden. */
export function compactBalance(value: string): string | undefined {
  const match = BALANCE_TEXT.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1]!.replace(/,/g, ''))
  if (!Number.isFinite(amount)) return undefined
  const unit = match[2]!.trim()
  return unit ? `${compactCount(amount)} ${unit}` : compactCount(amount)
}
const effectiveReset = (window: AggregatedWindow): number | undefined =>
  validTime(window.resetsAt) ? window.resetsAt : validTime(window.nextResetAt) ? window.nextResetAt : undefined
/** Permanent windows merge into one figure: summed amounts, else limit-weighted share, else mean share. */
function permanentLabel(windows: AggregatedWindow[]): string | undefined {
  if (!windows.length) return undefined
  const used = (window: AggregatedWindow): number | undefined =>
    finite(window.used) ? window.used : finite(window.remaining) ? 100 - window.remaining : undefined
  if (windows.every(window => finite(window.amount) && window.amount >= 0 && finite(window.limit) && window.limit > 0)) {
    const amount = windows.reduce((sum, window) => sum + window.amount!, 0)
    const limit = windows.reduce((sum, window) => sum + window.limit!, 0)
    if (limit > 0) {
      // One shared scale keeps the pair comparable: 900/1400 reads 0.9k/1.4k.
      const peak = Math.max(amount, limit)
      const divisor = peak >= 1e9 ? 1e9 : peak >= 1e6 ? 1e6 : peak >= 1000 ? 1000 : 1
      const suffix = divisor === 1 ? '' : divisor === 1e9 ? 'B' : divisor === 1e6 ? 'M' : 'k'
      return `${compactScaled(amount, divisor)}${suffix}/${compactScaled(limit, divisor)}${suffix}`
    }
  }
  if (windows.every(window => finite(window.limit) && window.limit > 0 && used(window) !== undefined)) {
    const total = windows.reduce((sum, window) => sum + window.limit!, 0)
    if (total > 0) {
      const spent = windows.reduce((sum, window) => sum + used(window)! * window.limit!, 0)
      return `${Math.round(Math.max(0, Math.min(100, 100 - spent / total)))}%`
    }
  }
  const shares = windows.map(window => share(window)).filter(finite)
  return shares.length === windows.length ? `${Math.round(shares.reduce((sum, value) => sum + value, 0) / shares.length)}%` : undefined
}
export function quotaHeadline(provider: QuotaProviderView | undefined, now = Date.now()): string {
  const quota = aggregateQuota(provider)
  if (!provider || !provider.accounts.length) return '暂无额度读数'
  if (!quota.eligible) return '额度暂不可用'
  if (quota.windows.length && quota.windows.every(window => window.kind === 'unlimited')) return '不限量'
  const resets: { at: number; window: AggregatedWindow }[] = []
  const expiries: { at: number; window: AggregatedWindow }[] = []
  const permanent: AggregatedWindow[] = []
  let balanceWindow: AggregatedWindow | undefined
  let hasText = false
  for (const window of quota.windows) {
    if (window.kind === 'unlimited') continue
    if (window.kind === 'balance') { balanceWindow ??= window; continue }
    if (window.kind !== 'percentage') { hasText = true; continue }
    const reset = effectiveReset(window)
    if (reset !== undefined) { resets.push({ at: reset, window }); continue }
    if (validTime(window.runsOutAt)) { expiries.push({ at: window.runsOutAt!, window }); continue }
    permanent.push(window)
  }
  const parts = resets.sort((a, b) => a.at - b.at)
    .map(({ at, window }) => `${countdownLabel(at, now)}R ${Math.round(share(window) ?? 0)}%`)
    .concat(expiries.sort((a, b) => a.at - b.at)
      .map(({ at, window }) => `${countdownLabel(at, now)}L ${Math.round(share(window) ?? 0)}%`))
  const merged = permanentLabel(permanent)
  if (merged) parts.push(merged)
  const balance = quota.balanceText ? compactBalance(quota.balanceText)
    : balanceWindow && finite(balanceWindow.amount)
      ? `${compactCount(balanceWindow.amount)}${balanceWindow.unit ? ` ${balanceWindow.unit}` : ''}` : undefined
  if (balance) parts.push(balance)
  if (!parts.length) return hasText || quota.balanceText ? '查看额度' : '暂无额度读数'
  return parts.join(' · ')
}
export function resetLabel(at: number | undefined, now = Date.now()): string | undefined {
  if (at === undefined || !Number.isFinite(at)) return undefined
  if (at <= now) return '等待更新'
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes < 60) return `${minutes} 分钟后重置`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} 小时 ${minutes % 60} 分后重置` : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`
}
