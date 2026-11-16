import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { runDirect } = vi.hoisted(() => ({ runDirect: vi.fn() }))
vi.mock('../src/executor/direct-runner.ts', async original => {
  const module = await original<typeof import('../src/executor/direct-runner.ts')>()
  return { ...module, runDirectWorker: runDirect }
})
import { SessionId } from '@deepseek-ai/dsh-session'
import { latestAssignment } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host
beforeEach(async () => {
  runDirect.mockReset()
  host = await startRuntime()
})
afterEach(async () => { await host.stop() })

async function acceptGrok(id: string, text: string) {
  const source = feishu(id, text)
  host.runtime.receive(source); await host.runtime.idle()
  const result = await host.route({ kind: 'accept', trigger_id: source.id, title: 'Direct worker', worktree_name: `direct-${id}`,
    acknowledgement: 'On it', harness: { harness: 'grok', model: 'grok-4.7-build-fast' }, harness_origin: 'user-specified' })
  await host.runtime.idle()
  return host.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
}

it('runs the external Harness directly by default with no intermediate DSH Session', async () => {
  expect(host.runtime.store.settings().executor.directWorkers).toBe(true)
  runDirect.mockResolvedValue({ status: 'finished', summary: 'did the work\n[[dsh-worker-report]]{\"state\":\"ready\",\"summary\":\"completed\"}', writeEvidence: { changedFiles: 1, completedEditCalls: 1 } })
  const ticket = await acceptGrok('991', 'Implement the requested change using the chosen Harness')
  expect(host.ctx.agents.get(SessionId('worker-' + ticket.id))).toBeUndefined()
  expect(runDirect).toHaveBeenCalledTimes(1)
  const call = runDirect.mock.calls[0] as unknown[]
  expect(call[3]).toMatchObject({ harness: 'grok' })
  expect(String(call[2])).toContain('Implement the requested change using the chosen Harness')
  expect(ticket.execution?.harnessRuns?.[0]?.harness).toBe('grok')
  expect(latestAssignment(ticket)?.report?.state).toBe('ready')
})

it('never marks the Ticket ready without an explicit Worker report marker', async () => {
  runDirect.mockResolvedValue({ status: 'finished', summary: 'made changes but no marker', writeEvidence: { changedFiles: 1, completedEditCalls: 1 } })
  const ticket = await acceptGrok('992', 'Please implement the change')
  expect(host.ctx.agents.get(SessionId('worker-' + ticket.id))).toBeUndefined()
  expect(runDirect).toHaveBeenCalledTimes(1)
  expect(ticket.execution?.harnessRuns?.[0]?.harness).toBe('grok')
  expect(latestAssignment(ticket)?.report?.state).toBe('progress')
})
