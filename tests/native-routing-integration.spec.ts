/** Native route tool integration: transaction, project target, execution receipt and WorkerSlots. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { agy, codex, grok } = vi.hoisted(() => ({ agy: vi.fn(), codex: vi.fn(), grok: vi.fn() }))
vi.mock('../src/app/tools/agy.ts', async original => {
  const module = await original<typeof import('../src/app/tools/agy.ts')>()
  return { ...module, ticketAgyTool: (ticket: Parameters<typeof module.ticketAgyTool>[0]) => ({ ...module.ticketAgyTool(ticket), execute: agy }) }
})
vi.mock('../src/app/tools/codex.ts', async original => {
  const module = await original<typeof import('../src/app/tools/codex.ts')>()
  return { ...module, ticketCodexTool: (ticket: Parameters<typeof module.ticketCodexTool>[0]) => ({ ...module.ticketCodexTool(ticket), execute: codex }) }
})
vi.mock('../src/app/tools/grok.ts', async original => {
  const module = await original<typeof import('../src/app/tools/grok.ts')>()
  return { ...module, ticketGrokTool: (ticket: Parameters<typeof module.ticketGrokTool>[0]) => ({ ...module.ticketGrokTool(ticket), execute: grok }) }
})
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { key, latestAssignment } from '../src/core/index.ts'
import { ticketEnvironment } from '../src/app/execution-environment.ts'

let host: Host
beforeEach(async () => {
  host = await startRuntime(); agy.mockReset().mockResolvedValue({ status: 'finished', harness: 'antigravity', requested_model: 'gemini-3.8-flash-medium' })
  codex.mockReset().mockResolvedValue({ status: 'finished', summary: 'done' })
  grok.mockReset().mockResolvedValue({
    status: 'finished', summary: 'done', requested_model: 'grok-4.7-build-fast', models: ['grok-4.7-build-fast'],
    cli_version: 'grok 1.0.80', session_id: 'session-123', request_id: 'request-456',
    usage: { inputTokens: 120, outputTokens: 32, totalTokens: 152, modelCalls: 1, costUSD: 0.0008 },
  })
})
afterEach(async () => { await host.stop() })
const route = (decisions: unknown[]) => host.runTool(host.runtime.masterId, 'orchestrator_route', { decisions })
const tasks = [
  { title: 'AGY change', scope: 'First authorized task', worktree_name: 'agy-change', harness: { harness: 'agy', model: '3.8f', forbid4a: true } },
  { title: 'Codex change', scope: 'Second authorized task', worktree_name: 'codex-change', harness: { harness: 'codex' } },
  { title: 'Native change', scope: 'Third authorized task', worktree_name: 'native-change', harness: { harness: 'dsh' } },
]
it('routes one message to three actual native workers, retains the source and never creates duplicate Tickets', async () => {
  const source = feishu('51', 'Three independent tasks, using the requested Harness for each. Do not commit.')
  host.runtime.receive(source); await host.runtime.idle()
  const result = await route([{ kind: 'accept', trigger_id: source.id, tasks, acknowledgement: 'On it: three independent changes.', note: 'Keep each scope independent.' }])
  expect((result.results as { tickets: unknown[] }[])[0]!.tickets).toHaveLength(3)
  await host.runtime.idle()
  const tickets = host.runtime.store.tickets.list()
  expect(tickets).toHaveLength(3)
  expect(host.runtime.store.receipts.get(key('ack', source.id))?.text).toBe('On it: three independent changes.')
  expect(tickets.every(t => t.execution?.assignment.includes('Keep each scope independent.'))).toBe(true)
  expect(tickets.every(t => t.origin.triggerId === source.id && latestAssignment(t)?.state === 'running')).toBe(true)
  expect(new Set(tickets.map(t => t.execution?.directory)).size).toBe(3)
  await route([{ kind: 'accept', trigger_id: source.id, tasks: [...tasks].reverse() }]); await host.runtime.idle()
  expect(host.runtime.store.tickets.list()).toHaveLength(3)
  expect(host.runtime.store.triggers.get(source.id)?.text).toBe(source.text)
})
it('rolls back all Tickets and launch effects if a later scope cannot prepare', async () => {
  const source = feishu('52', 'Two independent scopes'); host.runtime.receive(source); await host.runtime.idle()
  expect(() => host.runtime.engine.acceptTasks(source.id, { reason: 'explicit request', tasks: [
    { title: 'valid', scope: 'valid', name: 'valid' }, { title: 'invalid', scope: 'invalid', name: 'invalid/name' },
  ] })).toThrow()
  await host.runtime.idle()
  expect(host.runtime.store.tickets.list()).toHaveLength(0)
})
it('requires project clarification and resolves each task from the configured mapping, with no default test target', async () => {
  const source = { ...feishu('53', 'Two project changes'), meta: { projectRequired: true, projects: [
    { id: 'one', name: 'One', aliases: [], status: 'test', repository: 'acme/widgets', directory: '/tmp/project-one', localOnly: true },
    { id: 'two', name: 'Two', aliases: [], status: 'test', repository: 'acme/other', directory: '/tmp/project-two' },
  ] } }
  host.runtime.receive(source); await host.runtime.idle()
  const unresolved = await route([{ kind: 'accept', trigger_id: source.id, title: 'change', worktree_name: 'change', acknowledgement: 'On it' }])
  expect((unresolved.results as { refused: string }[])[0]!.refused).toContain('Choose an enabled configured project')
  expect(host.runtime.store.tickets.list()).toHaveLength(0)
  await route([{ kind: 'accept', trigger_id: source.id, tasks: tasks.slice(0, 2).map((task, i) => ({ ...task, project_id: i ? 'two' : 'one' })) }])
  await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list().find(t => t.execution?.project?.repository === 'acme/widgets')!
  expect(ticket.execution?.assignment).toContain('AGY, Codex and Grok execution remain allowed')
  expect(ticket.execution?.harness?.harness).toBe('agy')
  expect(ticket.execution?.project?.root).toBe('/tmp/project-one')
  const variables = ticketEnvironment({ deployment: host.runtime.deployment, settings: host.runtime.store.settings(), sources: host.runtime.sources, ticket, trigger: source })
  expect(variables.find(v => v.key === 'DSH_SUPERAGENT_PROJECT_ROOT')?.value).toBe('/tmp/project-one')
  expect(variables.find(v => v.key === 'DSH_SUPERAGENT_GITHUB_REPOSITORY')?.value).toBe('acme/widgets')
})
it('a required Harness must actually succeed, cannot silently fall back or use 4a, and keeps cancellation live', async () => {
  const source = feishu('54', 'Use AGY 3.8f only'); host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: 'AGY change', worktree_name: 'agy-change', acknowledgement: 'On it', harness: tasks[0]!.harness }]); await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!, worker = 'worker-' + ticket.id
  await expect(host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Claimed AGY without a run' })).rejects.toThrow('No successful execution')
  await expect(host.runTool(worker, 'orchestrator_codex', { task: 'Do the change', mode: 'write' })).rejects.toThrow('requires agy')
  await expect(host.runTool(worker, 'orchestrator_agy', { task: 'Do the change', model: '4a' })).rejects.toThrow('4a requires explicit authorization')
  agy.mockRejectedValueOnce(new Error('capacity exhausted'))
  await expect(host.runTool(worker, 'orchestrator_agy', { task: 'Do the change', model: '3.8f' })).rejects.toThrow('capacity exhausted')
  expect(host.runtime.store.tickets.get(ticket.id)?.execution?.harnessRun).toBeUndefined()
  await host.runTool(worker, 'orchestrator_agy', { task: 'Do the change', model: '3.8f' })
  expect(host.runtime.store.tickets.get(ticket.id)?.execution?.harnessRun).toMatchObject({ harness: 'agy', model: '3.8f', assignmentId: latestAssignment(ticket)!.id })
  expect(codex).not.toHaveBeenCalled()
  await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Verified Harness call completed' })
})

it('requires the Grok adapter for a Grok Ticket and records its run evidence without fallback', async () => {
  const source = feishu('55', 'Use Grok Build only for this change')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{
    kind: 'accept', trigger_id: source.id, title: 'Grok change', worktree_name: 'grok-change',
    acknowledgement: 'On it', harness: { harness: 'grok' },
  }])
  await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!, worker = 'worker-' + ticket.id
  await expect(host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Claimed Grok without a run' }))
    .rejects.toThrow('No successful execution')
  await expect(host.runTool(worker, 'orchestrator_codex', { task: 'Do the change', mode: 'write' })).rejects.toThrow('requires grok')
  await expect(host.runTool(worker, 'orchestrator_agy', { task: 'Do the change', model: '3.8f' })).rejects.toThrow('requires grok')

  grok.mockRejectedValueOnce(new Error('Grok authentication failed'))
  await expect(host.runTool(worker, 'orchestrator_grok', { task: 'Do the change', mode: 'write' }))
    .rejects.toThrow('Grok authentication failed')
  expect(host.runtime.store.tickets.get(ticket.id)?.execution?.harnessRun).toBeUndefined()
  await expect(host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Grok failed' }))
    .rejects.toThrow('No successful execution')

  await host.runTool(worker, 'orchestrator_grok', { task: 'Do the change', mode: 'write' })
  expect(host.runtime.store.tickets.get(ticket.id)?.execution?.harnessRun).toMatchObject({
    harness: 'grok', model: 'grok-4.7-build-fast', version: 'grok 1.0.80',
    models: ['grok-4.7-build-fast'], sessionId: 'session-123', requestId: 'request-456',
    usage: { inputTokens: 120, outputTokens: 32, totalTokens: 152, modelCalls: 1, costUSD: 0.0008 },
    assignmentId: latestAssignment(ticket)!.id,
  })
  expect(agy).not.toHaveBeenCalled()
  expect(codex).not.toHaveBeenCalled()
  await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Adapter reported a completed Grok run' })
})
