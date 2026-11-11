/** One original source and native authority, even when its accepted scopes need separate Tickets. */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, type Policy, type Trigger } from '../src/core/index.ts'

const message = (id: string, actor = 'ou_owner'): Trigger => ({
  id, source: 'feishu', actor: { source: 'feishu', id: actor }, human: true,
  addressed: 'direct', at: '2026-11-11T00:00:00.000Z', text: 'First scope and second scope. Do not commit. ' + '完整原始授权。'.repeat(600),
  threads: [{ source: 'feishu', id: 'oc_owner:om_' + id }],
  meta: { direct: true, chatId: 'oc_owner', messageId: 'om_' + id },
})
function setup() {
  const repo = new MemoryRepositories()
  const start = vi.fn(), stop = vi.fn()
  let inferred = false
  const policy: Policy = { version: 'test', paused: false, evalTimeoutMs: 30000,
    gate: trigger => trigger.actor.id === 'ou_owner' && trigger.human
      ? { admissible: true, strength: inferred ? 'inferred' : 'explicit', basis: { via: 'addressed', addressed: 'direct' } }
      : { admissible: false, reason: 'notAllowed' }, revalidate: () => true, admitsInferred: () => false }
  const options = { repo, policy: () => policy, executor: { start, stop, deliver: vi.fn() },
    assessor: { request: vi.fn() }, scope: { scope: () => ({ listened: true as const, observed: false, row: 'direct' }) },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } }
  return { repo, start, stop, engine: new Engine(options), restart: () => new Engine(options), infer: () => { inferred = true } }
}
const tasks = { reason: 'explicit request', tasks: [
  { title: 'First scope', scope: 'Only the first scope', name: 'first' },
  { title: 'Second scope', scope: 'Only the second scope', name: 'second' },
  { title: 'Third scope', scope: 'Only the third scope', name: 'third' },
] }

describe('native multi-Ticket acceptance', () => {
  it('keeps source text and authority intact, subscriptions intact, and retries idempotent across re-evaluation and restart', () => {
    const { repo, engine, restart, start } = setup()
    const original = message('one')
    expect(engine.receive(original)).toBe('stored')
    engine.evaluateDue()
    const accepted = engine.acceptTasks(original.id, tasks)
    expect(new Set(accepted.ticketIds).size).toBe(3)
    expect(start).toHaveBeenCalledTimes(3)
    const tickets = accepted.ticketIds.map(id => repo.tickets.get(id)!)
    expect(repo.triggers.get(original.id)).toEqual(original)
    for (const [index, ticket] of tickets.entries()) {
      expect(ticket.origin).toEqual({ triggerId: original.id, triggerIds: [original.id] })
      expect(ticket.mandate).toMatchObject({ actor: original.actor, strength: 'explicit', scope: tasks.tasks[index]!.scope })
    }
    expect(repo.threads.get('feishu:' + original.threads[0]!.id)?.subscriptions.sort()).toEqual([...accepted.ticketIds].sort())
    expect(engine.receive(original)).toBe('duplicate')
    expect(engine.acceptTasks(original.id, { ...tasks, tasks: [...tasks.tasks].reverse() })).toEqual(accepted)
    engine.reevaluate(original.id); engine.evaluateDue()
    expect(restart().acceptTasks(original.id, tasks)).toEqual(accepted)
    engine.decide(original.id, { kind: 'accept', title: 'different', scope: 'different', reason: 'replayed' })
    expect(repo.tickets.list()).toHaveLength(3)
  })

  it('stops, retries and attaches one Ticket independently through the original lifecycle', () => {
    const { repo, engine, start } = setup()
    const original = message('two'); engine.receive(original)
    const { ticketIds: [one, two, three] } = engine.acceptTasks(original.id, tasks)
    for (const id of [one!, two!, three!]) {
      const ticket = repo.tickets.get(id)!; engine.assignmentStarted(id, ticket.assignments[0]!.id)
    }
    engine.report(one!, { state: 'failed', summary: 'model unavailable' }); engine.retryTicket(one!)
    const cancelled = message('stop'); engine.receive(cancelled)
    engine.decide(cancelled.id, { kind: 'stop', ticketId: two!, reason: 'owner stopped only this Ticket' })
    expect(repo.tickets.get(two!)?.ended?.outcome).toBe('stopped')
    expect(repo.tickets.get(one!)?.ended).toBeUndefined()
    expect(repo.tickets.get(three!)?.assignments).toHaveLength(1)
    expect(start).toHaveBeenCalledTimes(4)
    const followup = message('followup'); engine.receive(followup); engine.attach(three!, followup.id)
    expect(repo.tickets.get(three!)?.inputs.some(i => i.kind === 'trigger' && i.triggerId === followup.id)).toBe(true)
    expect(repo.tickets.get(one!)?.inputs.some(i => i.kind === 'trigger' && i.triggerId === followup.id)).toBe(false)
    expect(repo.tickets.get(two!)?.inputs.some(i => i.kind === 'trigger' && i.triggerId === followup.id)).toBe(false)
  })

  it('refuses an unallowed or inferred source and cannot split a source that already accepted a single Ticket', () => {
    const { engine, repo, infer } = setup()
    const foreign = message('foreign', 'ou_other'); engine.receive(foreign)
    expect(() => engine.acceptTasks(foreign.id, tasks)).toThrow('not admissible')
    const single = message('single'); engine.receive(single)
    engine.decide(single.id, { kind: 'accept', title: 'single', scope: 'single', reason: 'owner' })
    expect(() => engine.acceptTasks(single.id, tasks)).toThrow('several independent tasks')
    const proactive = message('proactive'); engine.receive(proactive); infer()
    expect(() => engine.acceptTasks(proactive.id, tasks)).toThrow('explicit requests')
    expect(repo.tickets.list()).toHaveLength(1)
  })
})
