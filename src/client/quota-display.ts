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
/** Canonical short cycle plus duration for ordering; unknown names retain their short label. */
export function quotaPeriod(label: string): { label: string; minutes?: number } {
  const value = label.trim().toLowerCase()
  const compact = value.replace(/\s+/g, '')
  if (/^(?:weekly|week|1w|1week|7d|7days?|7天|每周|周)$/.test(compact)) return { label: '1w', minutes: 7 * 24 * 60 }
  if (/^(?:monthly|month|1m|1month|30d|30days?|30天|每月|月|1个月)$/.test(compact)) return { label: '1m', minutes: 30 * 24 * 60 }
  const hours = /^(\d+(?:\.\d+)?)(?:h|hours?|小时|小時)$/.exec(compact)
  if (hours && +hours[1]! > 0) return { label: `${+hours[1]!}h`, minutes: +hours[1]! * 60 }
  const days = /^(\d+(?:\.\d+)?)(?:d|days?|天|日)$/.exec(compact)
  if (days && +days[1]! > 0) return { label: `${+days[1]!}d`, minutes: +days[1]! * 24 * 60 }
  const weeks = /^(\d+(?:\.\d+)?)(?:w|weeks?|周|週)$/.exec(compact)
  if (weeks && +weeks[1]! > 0) return { label: `${+weeks[1]!}w`, minutes: +weeks[1]! * 7 * 24 * 60 }
  // Known vendor window names keep their canonical short form; everything unknown stays as supplied.
  if (/^夜间(?:流量)?$/.test(compact) || /^night(?:ly)?(?:[-_ ]?traffic)?$/.test(compact)) return { label: '夜间' }
  if (/^glm-5\.3-flash-trial/.test(compact)) return { label: '夜间' }
  return { label: label.trim().slice(0, 18) }
}
function countdown(at: number, now: number): string {
  if (at <= now) return '0m'
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h${minutes % 60}m` : `${Math.floor(hours / 24)}d${hours % 24}h`
}
export function quotaHeadline(provider: QuotaProviderView | undefined, now = Date.now()): string {
  const quota = aggregateQuota(provider)
  if (!provider || !provider.accounts.length) return '暂无额度读数'
  if (!quota.eligible) return '额度暂不可用'
  const percentages = quota.windows.filter(window => window.kind === 'percentage')
    .map((window, index) => ({ window, index, period: quotaPeriod(window.label) }))
    .sort((a, b) => (a.period.minutes ?? Infinity) - (b.period.minutes ?? Infinity) || a.index - b.index)
  if (percentages.length) {
    const reset = percentages.find(item => item.period.minutes !== undefined && validTime(item.window.nextResetAt))
    const time = reset ? `${countdown(reset.window.nextResetAt!, now)} | ` : ''
    return time + percentages.map(({window,period}) => `${period.label} ${Math.round(window.remaining ?? 0)}%`).join(' · ')
  }
  if (quota.balanceText || quota.windows.some(window => window.kind === 'balance')) return '余额 / 积分'
  if (quota.windows.length && quota.windows.every(window => window.kind === 'unlimited')) return '不限量'
  return quota.windows.length ? '查看额度' : '暂无额度读数'
}
export function resetLabel(at: number | undefined, now = Date.now()): string | undefined {
  if (at === undefined || !Number.isFinite(at)) return undefined
  if (at <= now) return '等待更新'
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes < 60) return `${minutes} 分钟后重置`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} 小时 ${minutes % 60} 分后重置` : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`
}
