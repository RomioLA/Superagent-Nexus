/** One original request split into several Tickets sends one batch summary when the whole batch ends. */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, type OutboundMessage, type Policy, type Trigger } from '../src/core/index.ts'

const message = (id: string): Trigger => ({
  id, source: 'feishu', actor: { source: 'feishu', id: 'ou_owner' }, human: true,
  addressed: 'direct', at: '2026-11-11T00:00:00.000Z', text: '请把这件事拆成两个范围处理。',
  threads: [{ source: 'feishu', id: 'oc_owner:om_' + id }],
  channel: { source: 'feishu', thread: 'oc_owner:om_' + id, address: { message: 'om_' + id } },
  meta: { direct: true, chatId: 'oc_owner', messageId: 'om_' + id },
})
function setup() {
  const repo = new MemoryRepositories()
  const sent: OutboundMessage[] = []
  const policy: Policy = { version: 'test', paused: false, evalTimeoutMs: 30000,
    gate: trigger => trigger.actor.id === 'ou_owner' && trigger.human
      ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } }
      : { admissible: false, reason: 'notAllowed' }, revalidate: () => true, admitsInferred: () => false }
  const options = { repo, policy: () => policy,
    executor: { start: vi.fn(), stop: vi.fn(), deliver: vi.fn() },
    assessor: { request: vi.fn() }, scope: { scope: () => ({ listened: true as const, observed: false, row: 'direct' }) },
    outbox: { send: (item: OutboundMessage): void => { sent.push(item) },
      status: (id: string) => sent.some(item => item.id === id) ? 'pending' as const : undefined, withdraw: vi.fn() } }
  return { repo, sent, engine: new Engine(options) }
}
const tasks = { reason: 'explicit request', tasks: [
  { title: 'Scope A', scope: 'Only Scope A' },
  { title: 'Scope B', scope: 'Only Scope B' },
] }
const summaries = (sent: OutboundMessage[]) => sent.filter(item => item.text.includes('批次汇总'))

describe('batch summary for one split request', () => {
  it('sends exactly one summary only after every Ticket of the batch ends', () => {
    const { engine, sent } = setup()
    const original = message('batch')
    engine.receive(original); engine.evaluateDue()
    const { ticketIds } = engine.acceptTasks(original.id, tasks)
    expect(ticketIds).toHaveLength(2)
    engine.report(ticketIds[0]!, { state: 'ready', summary: 'Scope A done' })
    expect(summaries(sent)).toHaveLength(0)
    engine.report(ticketIds[1]!, { state: 'ready', summary: 'Scope B done' })
    const batch = summaries(sent)
    expect(batch).toHaveLength(1)
    expect(batch[0]!.text).toContain('共 2 个工单')
    expect(batch[0]!.text).toContain('Scope A')
    expect(batch[0]!.text).toContain('Scope B')
    expect(batch[0]!.channel).toEqual(original.channel)
    // Processing the same end again must not send a second summary.
    ;(engine as unknown as { replies: { batchSummary(id: string): void } }).replies.batchSummary(ticketIds[1]!)
    expect(summaries(sent)).toHaveLength(1)
  })

  it('does not send a batch summary for an ordinary single-Ticket request', () => {
    const { engine, sent } = setup()
    const original = message('single')
    engine.receive(original); engine.evaluateDue()
    const decision = engine.decide(original.id, { kind: 'accept', title: 'Only scope', scope: 'Only scope', reason: 'owner' })
    engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    expect(summaries(sent)).toHaveLength(0)
  })
})
