import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, type Policy, type Trigger } from '../src/core/index.ts'
import { nativeTaskRequest } from '../src/sources/feishu-chat-router.ts'

const owner = 'ou_owner'
const thread = (id: string): Trigger => ({
  id, source: 'feishu', actor: { source: 'feishu', id: owner }, human: true,
  addressed: 'direct', at: new Date().toISOString(), text: '修改 README.md 简介',
  threads: [{ source: 'feishu', id: 'oc_owner:om_' + id }],
  meta: { direct: true, chatId: 'oc_owner', messageId: 'om_' + id },
}) as Trigger
describe('native Engine intake and ticket acceptance (no parallel router)', () => {
  it('accepts two independent worktrees, deduplicates repeated messages, and uses original retry/stop lifecycle', () => {
    const repo = new MemoryRepositories()
    const start = vi.fn()
    const executor = { start, deliver: vi.fn(), stop: vi.fn() }
    const policy: Policy = {
      version: 'test-policy', paused: false, evalTimeoutMs: 30000,
      gate: trigger => trigger.actor.id === owner
        ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } }
        : { admissible: false, reason: 'notAllowed' },
      revalidate: () => true, admitsInferred: () => false,
    }
    const engine = new Engine({
      repo, policy: () => policy, executor,
      assessor: { request: vi.fn() },
      scope: { scope: () => ({ listened: true, observed: false, row: 'direct' }) },
      outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
      prepareTicket: (ticket, request) => ({ ...ticket, execution: {
        name: request.name ?? 'task', directory: '/tmp/native-dsh/' + ticket.id, assignment: request.note ?? '',
      } }),
    })
    const inputs = ['a'.repeat(32), 'b'.repeat(32)].map(thread)
    const ids: string[] = []
    for (const trigger of inputs) {
      expect(engine.receive(trigger)).toBe('stored')
      const accepted = engine.decide(trigger.id, {
        kind: 'accept', ...nativeTaskRequest(trigger, trigger.text, 'write', 'Saworker/superagent-integration-test'),
        reason: 'user explicitly requested change',
      })
      expect(accepted.kind).toBe('accept')
      ids.push(accepted.ticketId!)
      expect(engine.receive(trigger)).toBe('duplicate')
    }
    expect(new Set(ids).size).toBe(2)
    expect(start).toHaveBeenCalledTimes(2)
    const dirs = ids.map(id => repo.tickets.get(id)?.execution?.directory)
    expect(new Set(dirs).size).toBe(2)
    expect(dirs.every(path => path?.startsWith('/tmp/native-dsh/'))).toBe(true)
    const first = repo.tickets.get(ids[0]!)!
    engine.assignmentStarted(first.id, first.assignments[0]!.id)
    engine.report(first.id, { state: 'failed', summary: 'simulated provider error' })
    engine.retryTicket(first.id)
    expect(start).toHaveBeenCalledTimes(3)
    engine.stopTicket(ids[1]!, 'user cancelled')
    expect(repo.tickets.get(ids[1]!)?.ended?.outcome).toBe('stopped')
  })
})