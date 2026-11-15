import { mkdir, writeFile, readFile } from 'node:fs/promises'
/** Native route tool integration: transaction, project target, execution receipt and WorkerSlots. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { agy, codex, grok } = vi.hoisted(() => ({ agy: vi.fn(), codex: vi.fn(), grok: vi.fn() }))
vi.mock('../src/app/tools/agy.ts', async original => {
  const module = await original<typeof import('../src/app/tools/agy.ts')>()
  return { ...module, ticketAgyTool: (ticket: Parameters<typeof module.ticketAgyTool>[0]) => ({ ...module.ticketAgyTool(ticket), execute: agy }) }
})
vi.mock('../src/app/tools/codex.ts', async original => {
  const module = await original<typeof import('../src/app/tools/codex.ts')>()
  return { ...module, ticketCodexTool: (ticket: Parameters<typeof module.ticketCodexTool>[0]) => {
    const selected = module.ticketCodexTool(ticket)
    return { ...selected, execute: async (raw: unknown, signal: AbortSignal) => {
      selected.schema.parse(raw)
      return codex(raw, signal)
    } }
  } }
})
vi.mock('../src/app/tools/grok.ts', async original => {
  const module = await original<typeof import('../src/app/tools/grok.ts')>()
  return { ...module, ticketGrokTool: (ticket: Parameters<typeof module.ticketGrokTool>[0]) => ({ ...module.ticketGrokTool(ticket), execute: grok }) }
})
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { key, latestAssignment } from '../src/core/index.ts'
import { ticketEnvironment } from '../src/app/execution-environment.ts'
import { evaluationInput } from '../src/app/evaluation.ts'

let host: Host
beforeEach(async () => {
  host = await startRuntime(); agy.mockReset().mockResolvedValue({ status: 'finished', harness: 'antigravity', requested_model: 'gemini-3.8-flash-medium' })
  codex.mockReset().mockResolvedValue({ status: 'finished', summary: 'done' })
  grok.mockReset().mockResolvedValue({
    status: 'finished', summary: 'done', requested_model: 'grok-4.7-build-fast', models: ['grok-4.7-build-fast'],
    write_evidence: { changedFiles: 1, completedEditCalls: 1 },
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
  const agyTicket = tickets.find(t => t.title === 'AGY change')!
  expect(host.runtime.store.receipts.get(key('ack', source.id))?.text).toBe(`Ticket ${agyTicket.shortId} | AGY change\n\nOn it: three independent changes.`)
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
  const unresolved = await route([{ kind: 'accept', trigger_id: source.id, title: 'change', worktree_name: 'change', acknowledgement: 'On it', harness: { harness: 'dsh' } }])
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

it('binds a Codex Ticket model from its structured HarnessSpec and records requested identity', async () => {
  const source = feishu('157', 'Use Codex gpt-6-luna for this change')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: 'Codex change', worktree_name: 'codex-model',
    acknowledgement: 'On it', harness: { harness: 'codex', model: 'gpt-6-luna' } }]); await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!, worker = 'worker-' + ticket.id
  // The structured model reaches the worker as an enforced constraint, not a shared-config write.
  expect(ticket.execution?.assignment).toContain('(model=gpt-6-luna)')
  expect(ticket.execution?.assignment).toContain('shared config.toml')
  expect(ticket.execution?.harness).toMatchObject({ harness: 'codex', model: 'gpt-6-luna' })
  await host.runTool(worker, 'orchestrator_codex', { task: 'Do the change', mode: 'write' })
  const run = host.runtime.store.tickets.get(ticket.id)?.execution?.harnessRun
  expect(run).toMatchObject({ harness: 'codex', model: 'gpt-6-luna', requestedModel: 'gpt-6-luna' })
  expect(run?.servedModel).toBeUndefined()
  expect(codex).toHaveBeenCalledTimes(1)
})

it('derives re-evaluable evidence from a routed Ticket without another model call', async () => {
  const source = feishu('160', 'Use Codex gpt-6-luna for this change')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: 'Codex evidence', worktree_name: 'codex-evidence',
    acknowledgement: 'On it', harness: { harness: 'codex', model: 'gpt-6-luna' } }]); await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!, worker = 'worker-' + ticket.id
  await host.runTool(worker, 'orchestrator_codex', { task: 'Do the change', mode: 'write' })
  const input = evaluationInput(host.runtime.store.tickets.get(ticket.id)!)
  expect(input.team).toMatchObject({ kind: 'single', members: ['codex'] })
  expect(input.runs[0]).toMatchObject({ harness: 'codex', status: 'finished', requestedModel: 'gpt-6-luna' })
  expect(input.dimensions.reliability).toEqual({ finished: 1, failed: 0, unverified: 0 })
  // The mock reports no served model or cost, so both stay unknown rather than becoming zero.
  expect(input.unknowns).toContain('served_model:codex')
  expect(input.unknowns).toContain('cost_usd')
  expect(input.dimensions.evidence.confidence).toBe('verified')
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
    harness: 'grok', model: 'grok-4.7-build-fast', requestedModel: 'grok-4.7-build-fast', version: 'grok 1.0.80',
    models: ['grok-4.7-build-fast'], sessionId: 'session-123', requestId: 'request-456',
    usage: { inputTokens: 120, outputTokens: 32, totalTokens: 152, modelCalls: 1, costUSD: 0.0008 },
    assignmentId: latestAssignment(ticket)!.id,
  })
  expect(agy).not.toHaveBeenCalled()
  expect(codex).not.toHaveBeenCalled()
  await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Adapter reported a completed Grok run' })
})

it('retains explicit AGY 3.8F constraints from semantic routing through Worker execution', async () => {
  const source = feishu('91', '必须用 orchestrator_agy，AGY 3.8F reasoning=high；禁止4A和其他执行器。')
  host.runtime.receive(source); await host.runtime.idle()
  const harness = { harness: 'agy', model: '3.8f', forbid4a: true, allowFallback: false }
  await route([{ kind: 'accept', trigger_id: source.id, title: 'Verify AGY', worktree_name: 'verify-agy', acknowledgement: '开始验收AGY。', harness }])
  await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!, worker = 'worker-' + ticket.id
  expect(ticket.execution?.harness).toEqual(harness)
  expect(ticket.execution?.assignment).toContain('AGY native CLI via orchestrator_agy')
  expect(ticket.execution?.assignment).not.toContain('DSH-native tools; do not delegate')
  await expect(host.runTool(worker, 'orchestrator_codex', { task: 'Verify this', mode: 'read-only' })).rejects.toThrow('requires agy')
  await expect(host.runTool(worker, 'orchestrator_agy', { task: 'Verify this', model: '4a', reasoning: 'high', mode: 'read-only' })).rejects.toThrow('4a requires explicit authorization')
  await host.runTool(worker, 'orchestrator_agy', { task: 'Verify this', model: '3.8f', reasoning: 'high', mode: 'read-only' })
  expect(agy).toHaveBeenCalledWith(expect.objectContaining({ model: '3.8f', reasoning: 'high' }), expect.any(AbortSignal))
  expect(host.runtime.store.tickets.get(ticket.id)?.execution?.harnessRun).toMatchObject({ harness: 'agy', model: '3.8f' })
})

it('keeps ordinary tasks on the default native DSH path when no Harness was requested', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('92', '请只读检查项目配置。'))
  expect(ticket.execution?.harness).toEqual({ harness: 'dsh' })
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Inspected with native tools.' })
  expect(agy).not.toHaveBeenCalled(); expect(codex).not.toHaveBeenCalled()
  expect(host.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
})

it('refuses an accept that puts an explicit Harness only in its note instead of structured constraints', async () => {
  const source = feishu('93', 'Use AGY 3.8F only, no fallback.')
  host.runtime.receive(source); await host.runtime.idle()
  const decision = { kind: 'accept', trigger_id: source.id, title: 'AGY check', worktree_name: 'agy-check', acknowledgement: 'On it',
    note: '必须经 orchestrator_agy 3.8f/high/read-only，禁4A与替代。' }
  const refused = await route([decision])
  expect((refused.results as { refused: string }[])[0]!.refused).toContain('accept needs structured harness')
  expect(host.runtime.store.tickets.list()).toHaveLength(0)
  await route([{ ...decision, harness: { harness: 'agy', model: '3.8f', forbid4a: true, allowFallback: false } }])
  await host.runtime.idle()
  expect(host.runtime.store.tickets.list()[0]?.execution?.harness).toEqual({ harness: 'agy', model: '3.8f', forbid4a: true, allowFallback: false })
})

it('requires an effective Harness for every split item before creating any Ticket', async () => {
  const source = feishu('94', 'Two independent checks.')
  host.runtime.receive(source); await host.runtime.idle()
  const result = await route([{ kind: 'accept', trigger_id: source.id, tasks: [tasks[0], { title: 'Other', worktree_name: 'other-check' }] }])
  expect((result.results as { refused: string }[])[0]!.refused).toContain('accept needs structured harness')
  expect(host.runtime.store.tickets.list()).toHaveLength(0)
})

it('does not authorize ready from an unverified write and permits ordinary recovery', async () => {
  const source = feishu('150', 'Use Grok for this change')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: 'Grok change', worktree_name: 'grok-change',
    acknowledgement: 'On it', harness: { harness: 'grok' } }]); await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!, worker = 'worker-' + ticket.id
  grok.mockResolvedValueOnce({ status: 'unverified', summary: 'No observed write', write_evidence: { changedFiles: 0, completedEditCalls: 0 } })
  await expect(host.runTool(worker, 'orchestrator_grok', { task: 'Write the file', mode: 'write' })).resolves.toMatchObject({ status: 'unverified' })
  expect(host.runtime.store.tickets.get(ticket.id)?.execution?.harnessRun).toBeUndefined()
  await expect(host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Claimed written' })).rejects.toThrow('No successful execution')
  await host.runTool(worker, 'orchestrator_grok', { task: 'Write the file', mode: 'write' })
  await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'File and checks verified.' })
  expect(host.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
})

it('allows native read-only completion without another acceptance flag or any file write', async () => {
  const source = feishu('151', 'Use Grok for read-only inspection, do not edit')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: 'Inspect', worktree_name: 'grok-inspect',
    acknowledgement: 'Inspecting', harness: { harness: 'grok' } }]); await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!, worker = 'worker-' + ticket.id
  grok.mockResolvedValue({ status: 'finished', summary: 'Inspected', models: ['grok-4.7-build-fast'] })
  await host.runTool(worker, 'orchestrator_grok', { task: 'Inspect the file', mode: 'read-only' })
  expect(host.runtime.store.tickets.get(ticket.id)?.execution?.harnessRun).toMatchObject({ mode: 'read-only' })
  await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Inspection complete, no files changed.' })
  expect(host.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
})

it('does not erase an earlier successful execution after an error or a no-op write attempt', async () => {
  const source = feishu('152', 'Use Grok to edit and check the file')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: 'Edit and check', worktree_name: 'grok-check',
    acknowledgement: 'On it', harness: { harness: 'grok' } }]); await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!, worker = 'worker-' + ticket.id
  await host.runTool(worker, 'orchestrator_grok', { task: 'Edit the file', mode: 'write' })
  const earlier = host.runtime.store.tickets.get(ticket.id)?.execution?.harnessRun
  grok.mockRejectedValueOnce(new Error('temporary CLI error'))
  await expect(host.runTool(worker, 'orchestrator_grok', { task: 'Check the file', mode: 'write' })).rejects.toThrow('temporary CLI error')
  expect(host.runtime.store.tickets.get(ticket.id)?.execution?.harnessRun).toEqual(earlier)
  grok.mockResolvedValueOnce({ status: 'unverified', summary: 'No new changes', write_evidence: { changedFiles: 0, completedEditCalls: 0 } })
  await host.runTool(worker, 'orchestrator_grok', { task: 'Check the file', mode: 'write' })
  expect(host.runtime.store.tickets.get(ticket.id)?.execution?.harnessRun).toEqual(earlier)
  // Every attempt is retained even though only the finished call drives the latest-successful receipt.
  expect(host.runtime.store.tickets.get(ticket.id)?.execution?.harnessRuns?.map(run => run.status))
    .toEqual(['finished', 'failed', 'unverified'])
  // The worker may inspect the actual target and finish through native reporting; no new write is required.
  await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Earlier edit and current target state verified.' })
  expect(host.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
})

it('keeps ordinary read-only review and authorized fallback on the native path', async () => {
  const source = feishu('153', 'Use Grok for inspection; read-only Codex fallback is allowed')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: 'Inspect', worktree_name: 'grok-review',
    acknowledgement: 'Inspecting', harness: { harness: 'grok', allowFallback: true } }]); await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!, worker = 'worker-' + ticket.id
  await host.runTool(worker, 'orchestrator_grok', { task: 'Inspect the file', mode: 'read-only' })
  await host.runTool(worker, 'orchestrator_codex', { task: 'Review the file', mode: 'read-only' })
  await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Authorized inspection complete; no files changed.' })
  expect(host.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
})

it('keeps the enforced fallback default when allowFallback is omitted, and blocks every CLI Harness for a DSH-native Ticket', async () => {
  // Omitted allowFallback means no silent substitution: the delegate guard rejects a different Harness, as the prompt states.
  const source = feishu('95', '必须用 AGY 3.8F；未说允许回退')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: 'AGY strict', worktree_name: 'agy-strict', acknowledgement: 'On it',
    harness: { harness: 'agy', model: '3.8f', forbid4a: true } }]); await host.runtime.idle()
  const agyTicket = host.runtime.store.tickets.list()[0]!, agyWorker = 'worker-' + agyTicket.id
  expect(agyTicket.execution?.assignment).toContain('Do not fall back to a different Harness on failure')
  await expect(host.runTool(agyWorker, 'orchestrator_codex', { task: 'Do the change', mode: 'write' })).rejects.toThrow('requires agy')
  await expect(host.runTool(agyWorker, 'orchestrator_grok', { task: 'Do the change', mode: 'write' })).rejects.toThrow('requires agy')

  // A DSH-native Ticket may not run any other CLI Harness; its native work tools stay available (see runtime.spec.ts).
  const dshSource = feishu('96', '直接用内置工具修好')
  host.runtime.receive(dshSource); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: dshSource.id, title: 'Native', worktree_name: 'native-dsh', acknowledgement: 'On it',
    harness: { harness: 'dsh' } }]); await host.runtime.idle()
  const dshTicket = host.runtime.store.tickets.list().find(ticket => ticket.id !== agyTicket.id)!, dshWorker = 'worker-' + dshTicket.id
  expect(dshTicket.execution?.assignment).toContain('DSH-native tools')
  await expect(host.runTool(dshWorker, 'orchestrator_agy', { task: 'Do it', model: '3.8f' })).rejects.toThrow('requires dsh')
  await expect(host.runTool(dshWorker, 'orchestrator_codex', { task: 'Do it', mode: 'write' })).rejects.toThrow('requires dsh')
  await expect(host.runTool(dshWorker, 'orchestrator_grok', { task: 'Do it', mode: 'write' })).rejects.toThrow('requires dsh')
})

it('retains every heterogeneous Harness call for one Ticket instead of overwriting earlier evidence', async () => {
  const source = feishu('155', 'Use AGY first, then a Codex review; fallback allowed')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: 'Evidence', worktree_name: 'evidence', acknowledgement: 'On it',
    harness: { harness: 'agy', model: '3.8f', forbid4a: true, allowFallback: true } }]); await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!, worker = 'worker-' + ticket.id
  const assignmentId = latestAssignment(ticket)!.id
  await host.runTool(worker, 'orchestrator_agy', { task: 'Do it', model: '3.8f' })
  agy.mockRejectedValueOnce(new Error('failed: Bearer FAKE-TEST-TOKEN-000000 denied'))
  await expect(host.runTool(worker, 'orchestrator_agy', { task: 'Retry', model: '3.8f' })).rejects.toThrow('denied')
  await host.runTool(worker, 'orchestrator_codex', { task: 'Review', mode: 'read-only' })
  const runs = host.runtime.store.tickets.get(ticket.id)!.execution!.harnessRuns!
  expect(runs.map(run => [run.harness, run.status])).toEqual([['agy', 'finished'], ['agy', 'failed'], ['codex', 'finished']])
  expect(runs.slice(0, 2).map(run => run.requestedModel)).toEqual(['gemini-3.8-flash-medium', 'gemini-3.8-flash-medium'])
  expect(runs[2]!.requestedModel).toBeUndefined()
  expect(runs.every(run => run.assignmentId === assignmentId)).toBe(true)
  // The failed call keeps a bounded, credential-free reason; no cost or tokens are invented for it.
  expect(runs[1]!.error).toBe('failed: Bearer [redacted] denied')
  expect(runs[1]!.usage).toBeUndefined()
  // Only the latest finished call drives the existing latest-receipt field.
  expect(host.runtime.store.tickets.get(ticket.id)!.execution!.harnessRun).toMatchObject({ harness: 'codex', status: 'finished' })
})

it('keeps a stored single harnessRun as history and persists the full run list in the Ticket record', async () => {
  const source = feishu('156', 'Use AGY for this change')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: 'Evidence', worktree_name: 'evidence-legacy', acknowledgement: 'On it',
    harness: { harness: 'agy', model: '3.8f', forbid4a: true } }])
  await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!, worker = 'worker-' + ticket.id
  await host.runTool(worker, 'orchestrator_agy', { task: 'Do it', model: '3.8f' })
  const earlier = host.runtime.store.tickets.get(ticket.id)!.execution!.harnessRun
  // Simulate an older Ticket that only stored the single latest receipt, then record a new call.
  const legacy = host.runtime.store.tickets.get(ticket.id)!
  legacy.execution!.harnessRuns = undefined
  host.runtime.store.tickets.save(legacy)
  await host.runTool(worker, 'orchestrator_agy', { task: 'Do it again', model: '3.8f' })
  const runs = host.runtime.store.tickets.get(ticket.id)!.execution!.harnessRuns!
  expect(runs).toHaveLength(2)
  expect(runs[0]).toEqual(earlier)
  // The list lives in the durable Ticket JSON, so it survives a restart that reopens the store.
  const row = host.runtime.store.db.prepare('SELECT value FROM ticket WHERE id = ?').get(ticket.id) as { value: string }
  expect((JSON.parse(row.value) as { execution: { harnessRuns: unknown[] } }).execution.harnessRuns).toHaveLength(2)
})

it('continues one historical Ticket with a per-call model and preserves untouched constraints, PR and workspace', async () => {
  const source = feishu('801', 'Use Grok, read only, forbid 4A, no fallback')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: 'Safe continuation', worktree_name: 'safe-continue', acknowledgement: 'Inspect the task.',
    harness: { harness: 'grok', mode: 'read-only', forbid4a: true, allowFallback: false } }]); await host.runtime.idle()
  const original = host.runtime.store.tickets.list()[0]!, worker = `worker-${original.id}`
  await host.runTool(worker, 'orchestrator_grok', { task: 'Inspect current files', mode: 'read-only' })
  const stored = host.runtime.store.tickets.get(original.id)!
  stored.assignments.at(-1)!.report = { state: 'failed', summary: '429 quota', at: new Date().toISOString() }
  host.runtime.store.tickets.save(stored)
  const change = feishu('802', 'Continue this task using Codex Luna6')
  host.runtime.receive(change); await host.runtime.idle()
  await mkdir(original.execution!.directory, { recursive: true })
  await writeFile(original.execution!.directory + '/retained.txt', 'existing uncommitted work')
  const oldJob = host.jobs.run(worker)
  const args = { ticket_id: original.id, trigger_id: change.id, harness: { harness: 'codex', model: 'gpt-6-luna' } }
  await host.runTool(host.runtime.masterId, 'orchestrator_ticket_continue', args); await host.runtime.idle()
  const continued = host.runtime.store.tickets.get(original.id)!
  expect(continued.execution?.directory).toBe(original.execution?.directory)
  expect(await readFile(original.execution!.directory + '/retained.txt', 'utf8')).toBe('existing uncommitted work')
  expect(host.jobs.service.kill).toHaveBeenCalledWith(oldJob, worker, 'Explicit human continuation')
  expect(continued.execution?.harness).toEqual({ harness: 'codex', model: 'gpt-6-luna', mode: 'read-only', forbid4a: true, allowFallback: false })
  expect(continued.assignments).toHaveLength(2)
  expect(continued.assignments[0]!.state).toBe('ended')
  expect(continued.execution?.harnessRuns?.[0]?.harness).toBe('grok')
  expect(continued.execution?.continuations?.[0]?.before?.harness).toBe('grok')
  const evidence = await host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: `ticket/${original.id}/evidence` }) as { text: string }
  expect(evidence.text).toContain('gpt-6-luna')
  expect(evidence.text).toContain('continuations')
  expect(host.agents.get(worker)!.cancel).toHaveBeenCalled()
  await expect(host.runTool(worker, 'orchestrator_codex', { task: 'Unsafe write', mode: 'write' })).rejects.toThrow('read-only')
  await host.runTool(worker, 'orchestrator_codex', { task: 'Inspect retained workspace', mode: 'read-only' })
  expect(host.runtime.store.tickets.get(original.id)?.execution?.harnessRuns?.at(-1)?.requestedModel).toBe('gpt-6-luna')
  await host.runTool(host.runtime.masterId, 'orchestrator_ticket_continue', args); await host.runtime.idle()
  expect(host.runtime.store.tickets.get(original.id)?.assignments).toHaveLength(2)
  expect(host.runtime.store.tickets.list()).toHaveLength(1)
})
it('records actual Harness failure immediately and sends one factual receipt with remaining task counts', async () => {
  const source = feishu('811', '请用 Grok 检查文件')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: '失败回执', worktree_name: 'failure-visible', acknowledgement: '检查文件。', harness: { harness: 'grok' } }]); await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!
  grok.mockRejectedValueOnce(new Error('403 permission denied at Grok endpoint'))
  await expect(host.runTool(`worker-${ticket.id}`, 'orchestrator_grok', { task: 'Inspect current file', mode: 'read-only' })).rejects.toThrow('403')
  expect(host.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('permission') })
  const results = host.runtime.store.db.prepare("SELECT value FROM outbox WHERE value ->> '$.ticketId' = ? AND value ->> '$.purpose' = 'result'").all(ticket.id).map(row => JSON.parse(String(row.value)) as { text: string })
  expect(results).toHaveLength(1)
  expect(results[0]?.text).toContain('任务尚未完成')
})
it('does not let another sender replace a Ticket resource or silently remove a retained 4A prohibition', async () => {
  const { ticket } = await host.acceptedTicket(feishu('821', 'Inspect the file'))
  const current = host.runtime.store.tickets.get(ticket.id)!
  current.execution!.harness = { harness: 'agy', model: '3.8f', forbid4a: true }; host.runtime.store.tickets.save(current)
  const other = feishu('822', 'Continue with 4A', { sender_id: 'ou_other' }); host.runtime.store.triggers.save(other)
  await expect(host.runTool(host.runtime.masterId, 'orchestrator_ticket_continue', { ticket_id: ticket.id, trigger_id: other.id,
    harness: { harness: 'codex', model: 'gpt-6-luna' } })).rejects.toThrow('does not belong')
  const change = feishu('823', 'Continue with 4A'); host.runtime.store.triggers.save(change)
  await expect(host.runTool(host.runtime.masterId, 'orchestrator_ticket_continue', { ticket_id: ticket.id, trigger_id: change.id,
    harness: { model: '4a' } })).rejects.toThrow('conflicts')
  expect(host.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(1)
})

it('stores attributable live reviews in existing Tickets and applies them through native candidate advice only', async () => {
  const context = { taskType: 'development', difficulty: 'complex', conditions: 'same requirements', ruleVersion: 'ac-v1' }
  const source = feishu('851', 'Two comparable tasks with authorized resources')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, acknowledgement: 'Inspect the two tasks.', tasks: [
    { title: 'Grok review sample', worktree_name: 'grok-quality', harness: { harness: 'grok' } },
    { title: 'Codex review sample', worktree_name: 'codex-quality', harness: { harness: 'codex', model: 'gpt-6-luna' } },
  ] }]); await host.runtime.idle()
  codex.mockResolvedValueOnce({ summary: 'done', models: ['gpt-6-luna'] })
  for (const ticket of host.runtime.store.tickets.list()) {
    const harness = ticket.execution!.harness!.harness as 'grok' | 'codex'
    await host.runTool(`worker-${ticket.id}`, `orchestrator_${harness}`, { task: 'Inspect and report the result', mode: 'read-only' })
    await host.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'progress', summary: 'Mock test evidence; fixture mechanism only.' })
    const review = { id: `review-${ticket.id}`, harness, model: harness === 'grok' ? 'grok-4.7-build-fast' : 'gpt-6-luna', ...context,
      artifact: `patch-${ticket.id}`, evaluator: 'reviewer', assignmentId: latestAssignment(ticket)!.id, evidenceRefs: [`ticket/${ticket.id}`],
      verdict: harness === 'grok' ? 'does-not-meet' : 'meets', origin: 'live', calibration: 'same objective criteria', sufficiency: 'explicit reviewer decision', at: '2026-11-15T00:00:00Z' }
    await expect(host.runTool(host.runtime.masterId, 'orchestrator_ticket_evaluate', { ticket_id: ticket.id, review: { ...review, origin: 'fixture' } })).rejects.toThrow('Fixture')
    await host.runTool(host.runtime.masterId, 'orchestrator_ticket_evaluate', { ticket_id: ticket.id, review })
    await expect(host.runTool(host.runtime.masterId, 'orchestrator_ticket_evaluate', { ticket_id: ticket.id, review: { ...review, verdict: 'unknown' } })).rejects.toThrow('immutable')
  }
  const result = await host.runTool(host.runtime.masterId, 'orchestrator_rank_candidates', { context, candidates: [
    { harness: 'grok', model: 'grok-4.7-build-fast', priority: 1, capable: true },
    { harness: 'codex', model: 'gpt-6-luna', priority: 2, capable: true },
  ] }) as { selected: { candidate: { harness: string } }; reason: string }
  expect(result.selected.candidate.harness).toBe('codex')
  expect(result.reason).toContain('calibrated quality evidence')
  expect(host.runtime.store.tickets.list()).toHaveLength(2)
})

it('blocks replacement execution when a Job cancellation was requested but not confirmed', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('871', 'Inspect the task'))
  host.jobs.run(sessionId)
  host.jobs.service.wait.mockResolvedValueOnce({ status: 'running' } as never)
  host.jobs.service.kill.mockImplementationOnce(() => 'requested')
  const request = feishu('872', 'Continue using Codex Luna6'); host.runtime.store.triggers.save(request)
  await host.runTool(host.runtime.masterId, 'orchestrator_ticket_continue', { ticket_id: ticket.id, trigger_id: request.id,
    harness: { harness: 'codex', model: 'gpt-6-luna' } })
  await host.runtime.idle()
  const current = host.runtime.store.tickets.get(ticket.id)!
  expect(latestAssignment(current)?.startedAt).toBeUndefined()
  expect(latestAssignment(current)?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('did not stop safely') })
  expect(codex).not.toHaveBeenCalled()
  host.runtime.engine.retryTicket(ticket.id); await host.runtime.idle()
  expect(latestAssignment(host.runtime.store.tickets.get(ticket.id)!)?.startedAt).toBeDefined()
})
it('keeps a late old-Harness failure on its original Assignment without failing the replacement', async () => {
  const source = feishu('881', 'Use Grok to inspect this task')
  host.runtime.receive(source); await host.runtime.idle()
  await route([{ kind: 'accept', trigger_id: source.id, title: 'Late completion', worktree_name: 'late-completion', acknowledgement: 'Inspect the task.', harness: { harness: 'grok' } }]); await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!, originalId = latestAssignment(ticket)!.id
  let reject!: (error: Error) => void
  grok.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const pending = host.runTool(`worker-${ticket.id}`, 'orchestrator_grok', { task: 'Inspect current workspace', mode: 'read-only' })
  void pending.catch(() => {})
  await vi.waitFor(() => expect(reject).toBeDefined())
  const change = feishu('882', 'Continue with Codex Luna6'); host.runtime.store.triggers.save(change)
  await host.runTool(host.runtime.masterId, 'orchestrator_ticket_continue', { ticket_id: ticket.id, trigger_id: change.id,
    harness: { harness: 'codex', model: 'gpt-6-luna' } }); await host.runtime.idle()
  reject(new Error('Old Grok request cancelled'))
  await expect(pending).rejects.toThrow('cancelled')
  const current = host.runtime.store.tickets.get(ticket.id)!
  expect(current.execution?.harnessRuns?.at(-1)).toMatchObject({ assignmentId: originalId, harness: 'grok', status: 'failed' })
  expect(latestAssignment(current)?.id).not.toBe(originalId)
  expect(latestAssignment(current)?.report).toBeUndefined()
})
