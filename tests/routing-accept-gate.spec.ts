/** The accept path uses a KNOWN exhausted Magpie reading to refuse dispatch instead of silently running an unusable Harness. */
import { afterEach, expect, it, vi } from 'vitest'

// Force the one DSH/Magpie channel to be known-exhausted, so acceptance must consult it rather than trusting the choice alone.
vi.mock('../src/app/magpie.ts', () => ({
  createMagpieReader: () => async () => ({
    status: 'ok',
    account_quotas: [{ account_ref: 'ref-a', state: 'ok', windows: [{ remaining: 0 }] }],
    request_usage: [{ provider: 'magpie', served_model: 'deepseek-v4.1-flash', account_ref: 'ref-a' }],
  }),
}))

import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { saveSelection } from '../src/app/models.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

it('refuses to accept a DSH Ticket when the only Magpie channel is known exhausted, creating no Ticket', async () => {
  host = await startRuntime()
  const source = feishu('901', 'Use the native tools for this change')
  host.runtime.receive(source); await host.runtime.idle()
  await expect(host.route({ kind: 'accept', trigger_id: source.id, title: 'Exhausted', worktree_name: 'exhausted-gate',
    acknowledgement: 'On it', harness: { harness: 'dsh' } })).rejects.toThrow(/exhausted/)
  expect(host.runtime.store.tickets.list()).toHaveLength(0)
})

it('refuses a route the user has disabled in the model authorization panel, creating no Ticket', async () => {
  host = await startRuntime()
  saveSelection(host.runtime.store, ['grok'])
  const source = feishu('902', 'Use the native tools for this change')
  host.runtime.receive(source); await host.runtime.idle()
  await expect(host.route({ kind: 'accept', trigger_id: source.id, title: 'Disabled', worktree_name: 'disabled-gate',
    acknowledgement: 'On it', harness: { harness: 'dsh' } })).rejects.toThrow(/disabled in the model authorization/)
  expect(host.runtime.store.tickets.list()).toHaveLength(0)
})
