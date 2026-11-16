/**
 * Positive authorization acceptance: when the user checks the observed (bare) served model, real dispatch must not be refused
 * because the configured role model is provider-qualified (`auto/deepseek-v4.1-flash`). This guards the logical-id normalization.
 */
import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { saveSelection } from '../src/app/models.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

it('accepts the DSH route the panel authorized even when the role model is provider-qualified', async () => {
  host = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, executor: { ...settings.executor, model: { provider: 'magpie-worker', model: 'auto/deepseek-v4.1-flash' } } })
  })
  const model = host.runtime.store.settings().executor.model!
  expect(model).toEqual({ provider: 'magpie-worker', model: 'auto/deepseek-v4.1-flash' })
  // The panel writes the observed served id (bare); dispatch carries the provider-qualified role model.
  saveSelection(host.runtime.store, ['dsh/deepseek-v4.1-flash'])
  const source = feishu('903', 'Use the native tools for this change')
  host.runtime.receive(source); await host.runtime.idle()
  const result = await host.route({ kind: 'accept', trigger_id: source.id, title: 'Authorized route',
    worktree_name: 'authorized-route', acknowledgement: 'On it', harness: { harness: 'dsh' } })
  expect(result.refused).toBeUndefined()
  expect(host.runtime.store.tickets.list()).toHaveLength(1)
})
