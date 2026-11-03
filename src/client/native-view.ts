/** Managed desktop guest. Owner RPC redeems credentials; the guest never requests the application host. */
export interface NativeBridge {
  acquire(storageKey: string): Promise<{ lease: string; partition: string }>
  release(lease: string): Promise<void>
  /** The host's lease-scoped notice that the guest asked to open a link in a new window. */
  onOpenRequested?(lease: string, listener: (url: string) => void): (() => void) | void
}
export interface NativeWebview {
  setAttribute(name: string, value: string): void
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
  getURL(): string
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
  remove(): void
}
export interface NativeLaunchClient {
  launchIssue(signal?: AbortSignal): Promise<{ token: string; expiresAt: number }>
  launchRedeem(token: string, signal?: AbortSignal): Promise<{ url: string; body: string }>
  launchRevoke(token: string): Promise<void>
}
export interface NativeState { phase: 'starting' | 'loading' | 'ready' | 'error'; error: string | null }
export interface NativeViewOptions {
  managementUrl: string
  storageKey: string
  onState: (state: NativeState) => void
  bridge?: NativeBridge
  createElement?: () => NativeWebview
  /** Open a user-clicked external link; the host routes https/http to the system browser. */
  openExternal?: (url: string) => void
}
/** Only the versioned desktop capability, never guessed IPC or custom guest configuration. */
export function nativeBridge(): NativeBridge | undefined {
  const carrier = (globalThis as unknown as { dshDesktop?: { protocolVersion?: unknown; browser?: unknown } }).dshDesktop
  if (carrier?.protocolVersion !== 1 || !carrier.browser || typeof carrier.browser !== 'object') return undefined
  const candidate = carrier.browser as Partial<NativeBridge>
  return typeof candidate.acquire === 'function' && typeof candidate.release === 'function' ? candidate as NativeBridge : undefined
}
type NavigationEvent = Event & { isMainFrame?: boolean; isInPlace?: boolean; url?: string; httpResponseCode?: number; errorCode?: number }

export function mountNativeView(host: HTMLElement, client: NativeLaunchClient, options: NativeViewOptions): () => void {
  const lifetime = new AbortController()
  const bridge = options.bridge ?? nativeBridge()
  let guest: NativeWebview | undefined
  let lease: string | undefined
  let ticket: string | undefined
  let stage: 'blank' | 'bootstrap' | 'authenticating' | 'page' = 'blank'
  let committed = false
  let bootstrapHttp: number | undefined
  let bootstrapCommitted = false
  let bootstrapDomReady = false
  let signinUrl = ''
  let rootUrl = ''
  let expectedOrigin = ''
  let blank = ''
  let ended = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let lastPhase: NativeState['phase'] | undefined
  let stopLinks: (() => void) | undefined
  const listeners: [string, EventListener][] = []
  let checkpoint = '创建网页容器'
  function state(phase: NativeState['phase'], error: string | null = null): void {
    if (ended || phase === lastPhase) return
    lastPhase = phase
    try { options.onState({ phase, error }) } catch { /* presentation must not leak ownership */ }
  }
  function revoke(token: string): void {
    try { void client.launchRevoke(token).catch(() => {}) } catch { /* no credential-bearing diagnostics */ }
  }
  function release(id: string): void {
    try { void bridge?.release(id).catch(() => {}) } catch { /* host owns guest destruction */ }
  }
  /** Only a plain http(s) address without credentials may leave the managed guest. */
  function externalUrl(value: string | undefined): string | undefined {
    try {
      const url = new URL(value ?? '')
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? url.username === '' && url.password === '' ? url.href : undefined
        : undefined
    } catch { return undefined }
  }
  function openExternal(value: string): void {
    try { options.openExternal?.(value) } catch { /* host policy may refuse; the guest stays put */ }
  }
  function cleanup(): void {
    if (ended) return
    ended = true
    if (timeout !== undefined) { clearTimeout(timeout); timeout = undefined }
    lifetime.abort()
    if (stopLinks !== undefined) { const stop = stopLinks; stopLinks = undefined; try { stop() } catch { /* owner already gone */ } }
    if (ticket !== undefined) { const value = ticket; ticket = undefined; revoke(value) }
    const element = guest
    guest = undefined
    if (element) {
      for (const [name, listener] of listeners) element.removeEventListener(name, listener)
      listeners.length = 0
      try { element.remove() } catch { /* release still required */ }
    }
    if (lease !== undefined) { const value = lease; lease = undefined; release(value) }
  }
  function fail(message: string): void { if (!ended) { state('error', message); cleanup() } }
  function currentUrl(): URL | undefined {
    try { return guest ? new URL(guest.getURL()) : undefined } catch { return undefined }
  }
  function validBootstrap(url: URL | undefined): boolean {
    // Magpie persists its own navigation with history.replaceState before DOM-ready.
    // Permit only its bounded, unique UI parameters; never signed-in URLs or arbitrary queries.
    if (!url || url.origin !== expectedOrigin || url.username || url.password || url.pathname !== new URL(rootUrl).pathname) return false
    const seen = new Set<string>()
    let valid = true
    url.searchParams.forEach((value, key) => {
      if (!['view', 'tab', 'edit'].includes(key) || seen.has(key) || value.length > 256) valid = false
      seen.add(key)
    })
    return valid
  }
  function validPage(url: URL): boolean {
    return url.origin === expectedOrigin && !url.username && !url.password && !url.searchParams.has('k') && !/\/_magpie\/sign-in\/?$/.test(url.pathname)
  }
  function ready(): void {
    if (ended || stage !== 'page' || !committed || lastPhase === 'ready') return
    const url = currentUrl()
    if (url && validPage(url)) {
      if (timeout !== undefined) { clearTimeout(timeout); timeout = undefined }
      // Navigation evidence only: no remote DOM inspection or assertion of account identity.
      state('ready')
    } else fail('Magpie 后台未完成加载，请检查连接设置后重新加载。')
  }
  function listen(name: string, callback: (event: NavigationEvent) => void): void {
    const listener: EventListener = event => {
      if (ended) return
      try { callback(event as NavigationEvent) } catch { fail('原生后台容器状态异常，请重新加载。') }
    }
    listeners.push([name, listener])
    guest!.addEventListener(name, listener)
  }
  async function authenticate(): Promise<void> {
    if (ended || stage !== 'bootstrap' || !bootstrapCommitted || !bootstrapDomReady) return
    if (!validBootstrap(currentUrl())) { fail('Magpie 登录页面地址不符合配置，已停止加载。'); return }
    stage = 'authenticating'
    try {
      checkpoint = '申请启动凭证';
      const issued = await client.launchIssue(lifetime.signal)
      if (ended) { revoke(issued.token); return }
      ticket = issued.token
      if (!ticket || !Number.isFinite(issued.expiresAt) || issued.expiresAt <= Date.now()) throw new Error('invalid ticket')
      checkpoint = '消费启动凭证';
      let descriptor: { url: string; body: string } | undefined = await client.launchRedeem(ticket, lifetime.signal)
      ticket = undefined
      if (ended) { descriptor = undefined; return }
      if (descriptor.url !== signinUrl || typeof descriptor.body !== 'string' || !validBootstrap(currentUrl())) throw new Error('invalid descriptor')
      // Sole fixed-script exception: perform the original login POST without following ANY redirect.
      // Native loadURL POST follows 307/308 and could forward credentials to another origin.
      // Parameters are JSON encoded; this reads no DOM and returns only an acceptance boolean.
      let code: string | undefined = `(async()=>{try{const url=${JSON.stringify(signinUrl)};const page=new URL(location.href);const root=new URL(${JSON.stringify(rootUrl)});if(page.origin!==root.origin||page.origin!==${JSON.stringify(expectedOrigin)}||page.pathname!==root.pathname||page.username||page.password)return false;const seen=new Set();let valid=true;page.searchParams.forEach((value,key)=>{if(!['view','tab','edit'].includes(key)||seen.has(key)||value.length>256)valid=false;seen.add(key)});if(!valid)return false;const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:${JSON.stringify(descriptor.body)},credentials:'same-origin',redirect:'manual'});return response.type==='opaqueredirect'||response.status===303}catch{return false}})()`
      descriptor = undefined
      checkpoint = '提交登录请求';
      const result = guest!.executeJavaScript(code)
      code = undefined
      const accepted = await result
      if (ended) return
      if (accepted !== true || !validBootstrap(currentUrl())) throw new Error('login not accepted')
      stage = 'page'
      committed = false
      checkpoint = '加载后台首页';
      await guest!.loadURL(rootUrl) // Clean GET: never replay the credential-bearing POST body.
      if (ended) return
    } catch {
      if (!ended) fail('无法自动打开 Magpie 后台，请检查连接设置后重新加载。')
    }
  }
  async function loadBootstrap(): Promise<void> {
    stage = 'bootstrap'
    checkpoint = '等待管理页面导航和就绪事件';
    bootstrapCommitted = false
    bootstrapDomReady = false
    bootstrapHttp = undefined
    state('loading')
    try { await guest!.loadURL(rootUrl) } catch {
      // Root is HTTP 401 without a cookie, 200 with one. GET sign-in can become 404 when signed in.
      // No DNS/TLS/connection failure is accepted as a bootstrap document.
      if (!ended && !(bootstrapHttp === 401 && validBootstrap(currentUrl()))) fail('Magpie 登录页面加载失败，请检查网络后重新加载。')
    }
  }
  state('starting')
  if (!bridge) { fail('此功能需要支持原生网页容器的 DSH 桌面端。'); return cleanup }
  try {
    const management = new URL(options.managementUrl)
    if (!['http:', 'https:'].includes(management.protocol) || management.username || management.password || management.search || management.hash || !options.storageKey.trim()) throw new Error('invalid configuration')
    const base = management.href.replace(/\/+$/, '')
    signinUrl = `${base}/_magpie/sign-in`
    rootUrl = `${base}/`
    expectedOrigin = management.origin
  } catch { fail('Magpie 后台隔离会话配置无效。'); return cleanup }
  timeout = setTimeout(() => { fail(`Magpie 后台启动超时（${checkpoint}），请重试。`) }, 30_000)
  void (async () => {
    try {
      const reservation = await bridge.acquire(options.storageKey)
      if (ended) { release(reservation.lease); return }
      lease = reservation.lease
      if (!lease || !reservation.partition) throw new Error('invalid reservation')
      // New-window links in the original page: the host denies them inside the
      // guest and asks the owning window instead. Open them in the system
      // browser; nothing is loaded in the background and the panel keeps state.
      if (typeof bridge.onOpenRequested === 'function') {
        const leaseId = lease
        try {
          const stop = bridge.onOpenRequested(leaseId, url => { const href = externalUrl(url); if (href) openExternal(href) })
          if (typeof stop === 'function') stopLinks = stop
        } catch { /* older host bridge: links keep the host default */ }
      }
      guest = options.createElement?.() ?? document.createElement('webview') as unknown as NativeWebview
      blank = `about:blank#${lease}`
      guest.setAttribute('name', lease)
      guest.setAttribute('partition', reservation.partition)
      guest.setAttribute('src', blank)
      // The guest's window.open only reaches the host's new-window handler when
      // popups are enabled; the host still denies every popup and merely reports
      // the URL to us. Without this attribute a link click is silently dropped.
      guest.setAttribute('allowpopups', '')
      guest.setAttribute('aria-label', 'Magpie 原版管理后台')
      guest.setAttribute('style', 'display:flex;width:100%;height:100%;min-height:0;flex:1')
      listen('dom-ready', () => {
        if (stage === 'blank') {
          if (guest?.getURL() !== blank) { fail('原生后台容器初始化失败，请重新加载。'); return }
          void loadBootstrap()
        } else if (stage === 'bootstrap') {
          // A delayed about:blank dom-ready can arrive after loadURL(root) starts.
          // It is not evidence that the configured page has committed.
          if (guest?.getURL() === blank && !bootstrapCommitted) return
          if (!validBootstrap(currentUrl())) { fail('Magpie 登录页面地址不符合配置，已停止加载。'); return }
          bootstrapDomReady = true
          void authenticate()
        } else ready()
      })
      listen('did-start-navigation', event => {
        if (stage === 'page' && event.isMainFrame !== false && event.isInPlace !== true) { committed = false; state('loading') }
      })
      listen('did-navigate', event => {
        if (stage === 'blank' || event.isMainFrame === false) return
        let url: URL
        try { url = new URL(event.url ?? guest!.getURL()) } catch { fail('Magpie 后台导航无效，请重新加载。'); return }
        if (stage === 'bootstrap' || stage === 'authenticating') {
          if (stage === 'bootstrap' && !bootstrapCommitted && url.href === blank) return
          if (!validBootstrap(url)) { fail('Magpie 登录页面跳转到非预期地址，已停止加载。'); return }
          bootstrapHttp = event.httpResponseCode
          if (bootstrapHttp !== 200 && bootstrapHttp !== 401) { fail('Magpie 登录页面请求失败，请检查连接设置后重新加载。'); return }
          bootstrapCommitted = true
          // Support DOM-ready preceding the main-frame navigation notification,
          // without treating that DOM-ready alone as permission to redeem a key.
          if (stage === 'bootstrap' && bootstrapDomReady) void authenticate()
          return
        }
        if (!validPage(url)) {
          // A same-tab click on an outside link navigated the already loaded
          // backend away. Send it to the system browser and bring the panel back
          // to the management root; the initial root commitment stays strict.
          const href = committed ? externalUrl(url.href) : undefined
          if (href !== undefined && url.origin !== expectedOrigin) {
            openExternal(href)
            checkpoint = '返回后台首页'
            void guest!.loadURL(rootUrl).catch(() => { if (!ended) fail('Magpie 后台加载失败，请检查网络后重新加载。') })
            return
          }
          fail('Magpie 后台跳转到非预期地址，已停止加载。'); return
        }
        // Only the first root commitment gates readiness. Later in-app navigations
        // (a 404 page, a transient 502, a 304 revalidation) are the original
        // backend's own state and must not tear down the retained container.
        if (!committed) {
          if (event.httpResponseCode !== 200) { fail('Magpie 后台请求失败，请检查连接设置后重新加载。'); return }
          committed = true
        }
      })
      listen('did-navigate-in-page', event => {
        if (event.isMainFrame === false || stage === 'blank') return
        let url: URL
        try { url = new URL(event.url ?? guest!.getURL()) } catch { fail('Magpie 后台导航无效，请重新加载。'); return }
        if (stage === 'bootstrap' || stage === 'authenticating') {
          if (!validBootstrap(url)) { fail('Magpie 登录页面跳转到非预期地址，已停止加载。'); return }
          // In-page history is not an HTTP commitment. Keep any earlier real navigation evidence.
          if (stage === 'bootstrap' && bootstrapDomReady) void authenticate()
          return
        }
        if (!validPage(url)) { fail('Magpie 后台跳转到非预期地址，已停止加载。'); return }
        ready() // Only an already committed HTTP 200 can make this transition ready.
      })
      listen('did-stop-loading', () => { ready() })
      listen('did-fail-load', event => {
        if (event.isMainFrame === false || event.errorCode === -3) return
        if ((stage === 'bootstrap' || stage === 'authenticating') && event.errorCode === -379 && bootstrapHttp === 401 && validBootstrap(currentUrl())) return
        fail('Magpie 后台加载失败，请检查网络后重新加载。')
      })
      for (const name of ['render-process-gone', 'destroyed']) listen(name, () => fail('Magpie 后台容器已关闭，请重新加载。'))
      checkpoint = '等待容器初始页面'; host.appendChild(guest as unknown as Node);
    } catch {
      if (!ended) fail('无法创建原生后台容器，请使用受支持的 DSH 桌面端。')
    }
  })()
  return cleanup
}
