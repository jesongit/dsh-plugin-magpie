import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MagpieClient } from './state.ts'
import { MagpieIcon, MagpiePanel, MagpieSettings } from './components.tsx'
import { ModelQuotaDock } from './ModelQuotaDock.tsx'
import { ModelSelectionSource, createCurrentModelReader } from './model-selection.ts'
import type { ModelDirectoriesLike } from './model-selection.ts'
import { css } from './styles.ts'
import { installSettingsIcon } from './settings-icon.ts'
import { RetainedSurface } from './retained-surface.ts'
import { RetainedManagement } from './NativeManagement.tsx'

export const inject = ['slots', 'connection', 'layout']
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const client = new MagpieClient(connection.rpc)
  const surface = new RetainedSurface(client)
  const selections = new Map<string, ModelSelectionSource>()
  const selectedFor = (sessionId: string) => {
    let selection = selections.get(sessionId)
    if (!selection) {
      selection = new ModelSelectionSource(createCurrentModelReader(() => ctx.get('modelDirectories') as ModelDirectoriesLike | undefined, sessionId))
      selections.set(sessionId, selection)
    }
    return selection
  }
  const open = () => ctx.layout.selectPanel('magpie' as MainPanelId)
  const props = () => ({ client, open, surface })
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-plugin-magpie'
    style.textContent = css
    document.head.appendChild(style)
    return () => { for (const selection of selections.values()) selection.dispose(); selections.clear(); surface.dispose(); client.dispose(); style.remove() }
  }, 'magpie native chrome')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'magpie', inject: props }, MagpiePanel))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'magpie-management-retained', order: 0, inject: props }, RetainedManagement))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'magpie', order: 40, label: 'Magpie' }, MagpieIcon))
  ctx.effect(installSettingsIcon, 'magpie settings navigation icon')
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'magpie', order: 91, label: 'Magpie', inject: props }, MagpieSettings))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'magpie-status', order: 11, inject: (sessionId: string) => ({ client, selection: selectedFor(sessionId) }) }, ModelQuotaDock))
  void client.read()
}
