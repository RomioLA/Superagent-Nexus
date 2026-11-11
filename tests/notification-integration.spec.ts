import { describe, expect, it } from 'vitest'
import { reportRelay, resultRelay } from '../src/app/notices.ts'
import type { Ticket } from '../src/core/index.ts'

const ticket = (overrides: Record<string, unknown> = {}) => ({
  id: 'ticket-1234567890', title: 'Fix', updatedAt: '2026-11-11T10:00:00Z',
  origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }, channels: [], assignments: [], mandate: { strength: 'explicit' }, undelivered: [],
  ...overrides,
}) as unknown as Ticket

describe('native worker notification routing', () => {
  it('keeps progress internal and routes failed/blocked questions only to the current attention', () => {
    const asked = ticket({ attention: { id: 'question-1', question: 'Which option?' } })
    expect(reportRelay(asked, { state: 'progress', summary: 'Halfway.' })).toBeUndefined()
    expect(reportRelay(asked, { state: 'blocked', summary: 'Which option?', question: 'Which option?' })).toMatchObject({
      id: 'attention:ticket-1234567890:question-1', text: expect.stringContaining('"kind":"worker_attention"'),
    })
    expect(reportRelay(asked, { state: 'failed', summary: 'Need a decision.', question: 'Which option?' })).toMatchObject({
      id: 'attention:ticket-1234567890:question-1', text: expect.stringContaining('"kind":"worker_attention"'),
    })
    expect(reportRelay(asked, { state: 'failed', summary: 'Worker crashed.' })).toMatchObject({
      id: expect.stringMatching(/^report:/), text: expect.stringContaining('"kind":"worker_report"'),
    })
  })

  it('keeps worker report content readable across wording changes', () => {
    const a = resultRelay(ticket(), 'failed', 'Provider unavailable.')
    const b = resultRelay(ticket({ updatedAt: '2026-11-11T10:05:00Z' }), 'failed', 'The provider is still unavailable.')
    expect(JSON.parse(a.text)).toMatchObject({ kind: 'worker_report', state: 'failed', summary: 'Provider unavailable.' })
    expect(JSON.parse(b.text)).toMatchObject({ kind: 'worker_report', state: 'failed', summary: 'The provider is still unavailable.' })
  })
})

import { afterEach, beforeEach } from 'vitest'
import { key } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host
beforeEach(async () => { host = await startRuntime() })
afterEach(async () => { await host.stop() })

describe('Runtime result delivery', () => {
  it('queues one automatic stop receipt and deduplicates a later result with changed wording', async () => {
    const { ticket } = await host.acceptedTicket(feishu('51', '@bot stop this'))
    host.runtime.engine.stopTicket(ticket.id, 'No longer needed')
    await host.runtime.idle()
    const ended = host.runtime.store.tickets.get(ticket.id)!
    expect(ended.ended).toMatchObject({ by: 'human', outcome: 'stopped' })
    const id = key('result', ticket.id, ended.assignments.at(-1)!.id, 'stopped', ended.ended!.at)
    const original = host.runtime.store.receipts.get(id)!
    expect(original).toMatchObject({ kind: 'reply', purpose: 'result', ticketId: ticket.id, status: 'sent' })
    const repeated = host.runtime.engine.reply({ purpose: 'result', ticketId: ticket.id, text: 'Stopped; existing work remains.' })
    expect(repeated).toMatchObject({ id, reused: true, status: 'sent' })
    expect(host.runtime.store.receipts.get(id)?.text).toBe(original.text)
    expect(host.runtime.engine.reply({ purpose: 'result', ticketId: ticket.id, text: 'Another wording.' }).id).toBe(id)
  })

  it.each(['failed', 'blocked'] as const)('allows a main result after a native %s report and reuses the report-time receipt', async state => {
    const { ticket, sessionId } = await host.acceptedTicket(feishu(state === 'failed' ? '61' : '62', `@bot ${state} task`))
    await host.runTool(sessionId, 'orchestrator_report', { state, summary: `Worker ${state}.` })
    await host.runtime.idle()
    expect(host.relays(host.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', state })
    const report = host.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report!
    expect(report).toMatchObject({ state })
    const first = host.runtime.engine.reply({ purpose: 'result', ticketId: ticket.id, text: `The task ${state}.` })
    const second = host.runtime.engine.reply({ purpose: 'result', ticketId: ticket.id, text: 'Updated wording for the same report.' })
    expect(second).toMatchObject({ id: first.id, reused: true })
    expect(first.id).toBe(key('result', ticket.id, host.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.id, state, report.at))
    expect(host.runtime.store.receipts.get(first.id)?.text).toBe(`The task ${state}.`)
  })

  it('refuses a result while attention is open, then allows its matching attention reply', async () => {
    const { ticket, sessionId } = await host.acceptedTicket(feishu('71', '@bot update this'))
    await host.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Need a choice.', human_action: 'Which option?' })
    await host.runtime.idle()
    expect(host.relays(host.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_attention', state: 'progress' })
    const current = host.runtime.store.tickets.get(ticket.id)!
    expect(current.attention?.question).toBe('Which option?')
    expect(() => host.runtime.engine.reply({ purpose: 'result', ticketId: ticket.id, text: 'Done.' })).toThrow(/Ticket is not ready for delivery/)
    const attention = host.runtime.engine.reply({ purpose: 'attention', ticketId: ticket.id, question: 'Which option?', text: 'Which option?' })
    await host.runtime.idle()
    await host.runtime.sendReplies()
    expect(host.runtime.store.replyStatus(attention.id)).toBe('sent')
    expect(host.runtime.store.receipts.get(attention.id)).toMatchObject({ kind: 'reply', ticketId: ticket.id, status: 'sent' })
  })

  it('allows a completion result only after the ticket is actually completed', async () => {
    const { ticket, sessionId } = await host.acceptedTicket(feishu('81', '@bot finish this'))
    await host.runtime.sendReplies()
    await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Completed.' })
    await host.runtime.idle()
    await host.runtime.sendReplies()
    const completed = host.runtime.store.tickets.get(ticket.id)!
    expect(completed.ended?.outcome).toBe('completed')
    const reply = host.runtime.engine.reply({ purpose: 'result', ticketId: ticket.id, text: 'Completed.' })
    await host.runtime.idle()
    await host.runtime.sendReplies()
    expect(host.runtime.store.replyStatus(reply.id)).toBe('sent')
    expect(host.runtime.store.receipts.get(reply.id)).toMatchObject({ purpose: 'result', ticketId: ticket.id, status: 'sent' })
  })
})

it('reuses the native PR merge receipt when the main Session requests a result', async () => {
  const { ticket, sessionId, trigger } = await host.acceptedTicket(feishu('91', '@bot 修复并提交 PR'))
  host.runtime.engine.bindThread(ticket.id, { source: 'github', id: '42' }, true)
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' })
  await host.runtime.idle()
  host.runtime.engine.threadClosed({ source: 'github', id: '42' }, 'merged', new Date().toISOString())
  await host.runtime.idle()

  const ended = host.runtime.store.tickets.get(ticket.id)!
  expect(ended.ended?.outcome).toBe('merged')
  const nativeId = key('pr-terminal', '42', 'feishu', JSON.stringify(trigger.channel!.address), 'merged')
  const nativeReceipt = host.runtime.store.receipts.get(nativeId)!
  expect(nativeReceipt).toMatchObject({ kind: 'notice', ticketId: ticket.id, status: 'sent' })

  const reply = await host.runTool(host.runtime.masterId, 'orchestrator_reply', {
    ticket_id: ticket.id, purpose: 'result', text: 'PR #42 has merged and the work is complete.',
  })
  expect(reply).toEqual({ status: nativeReceipt.status })
  expect(host.runtime.store.replyStatus(nativeId)).toBe('sent')
  const mainResultId = key('result', ticket.id, ended.assignments.at(-1)!.id, 'merged', ended.ended!.at)
  expect(host.runtime.store.replyStatus(mainResultId)).toBeUndefined()
})
