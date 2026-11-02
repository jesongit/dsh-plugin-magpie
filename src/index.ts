import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { MagpieService } from './service.ts'
import { MagpieAdapter } from './adapter.ts'
import { registerRpc } from './rpc.ts'

export const name = 'magpie-connector'
export const inject = ['llm']

/** All provider groups share one protocol adapter; Magpie owns account policy. */
export async function apply(ctx: Context): Promise<void> {
  let registration: AdapterRegistrationHandle | undefined
  let disposed = false
  const service = new MagpieService({
    storePath: dshHomePath('plugins', 'magpie', 'connection.json'),
    onCatalogChanged: () => { if (!disposed) syncRoutes() }
  })
  const adapter = new MagpieAdapter(service, () => ctx.get('attachments') as AttachmentStore | undefined)
  function syncRoutes(): void {
    const routes = service.catalog().map(group => group.route)
    // DSH rejects an initially empty registration. Stay dormant until discovery.
    if (!registration && routes.length) registration = ctx.llm.registerAdapter(routes, adapter)
    else if (registration) registration.replace(routes)
  }
  await service.initialize()
  syncRoutes()
  ctx.effect(() => () => { disposed = true; registration?.(); service.dispose() }, 'magpie connector lifecycle')
  registerRpc(ctx, service)

  // One shared low-frequency directory refresh, not one timer per conversation.
  const timer = setInterval(() => {
    if (service.status().configured) void service.refresh().catch(() => { /* sanitized status is exposed to UI */ })
  }, 5 * 60_000)
  timer.unref()
  ctx.effect(() => () => clearInterval(timer), 'magpie catalog refresh')
}
