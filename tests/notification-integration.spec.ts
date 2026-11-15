import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reportRelay, resultRelay } from '../src/app/notices.ts'
import type { Ticket } from '../src/core/index.ts'
import { IM_WORDS, wordCount } from '../src/infra/text.ts'

const ticket = (overrides: Record<string, unknown> = {}) => ({
  id: 'ticket-1234567890', title: 'Fix', updatedAt: '2026-11-11T10:00:00Z',
  origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }, channels: [], assignments: [], mandate: { strength: 'explicit' }, undelivered: [],
  ...overrides,
}) as unknown as Ticket

describe('native worker notification routing', () => {
  it('keeps progress internal and preserves terminal results with their attention', () => {
    const asked = ticket({ attention: { id: 'question-1', question: 'Which option?' } })
    expect(reportRelay(asked, { state: 'progress', summary: 'Halfway.' })).toBeUndefined()
    expect(reportRelay(asked, { state: 'blocked', summary: 'Which option?', question: 'Which option?' })).toMatchObject({
      id: expect.stringMatching(/^report:/), text: expect.stringContaining('"kind":"worker_report"'),
    })
    expect(reportRelay(asked, { state: 'failed', summary: 'Need a decision.', question: 'Which option?' })).toMatchObject({
      id: expect.stringMatching(/^report:/), text: expect.stringContaining('"kind":"worker_report"'),
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

it.each(['blocked', 'failed'] as const)('delivers %s with human_action once as a result and suppresses a separate repeated question', async state => {
  const { ticket, sessionId, trigger } = await host.acceptedTicket(feishu('101', '@bot verify this'))
  await host.runTool(sessionId, 'orchestrator_report', { state, summary: 'Provider unavailable; checks passed.', human_action: 'Retry later?' })
  await host.runtime.idle()
  expect(host.relays(host.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', state,
    summary: 'Provider unavailable; checks passed.', ticket: { attention: { question: 'Retry later?' } } })
  const reply = { purpose: 'result' as const, ticketId: ticket.id, question: 'Retry later?', text: 'Provider unavailable; checks passed. Retry later?' }
  const first = host.runtime.engine.reply(reply)
  await host.runtime.sendReplies()
  expect(host.runtime.store.receipts.get(first.id)).toMatchObject({ purpose: 'result', status: 'sent', channel: trigger.channel })
  expect(host.runtime.engine.reply({ ...reply, text: 'Same report, different words.' })).toMatchObject({ id: first.id, reused: true })
  expect(host.runtime.engine.reply({ purpose: 'attention', ticketId: ticket.id, question: 'Retry later?', text: 'Retry later?' }))
    .toMatchObject({ id: first.id, reused: true, status: 'sent' })
  // The question remains actionable, while a later status report must not ask it again.
  await host.runTool(sessionId, 'orchestrator_report', { state, summary: 'Still unavailable.', human_action: 'Retry later?' })
  expect(host.runtime.engine.reply({ purpose: 'attention', ticketId: ticket.id, question: 'Retry later?', text: 'Retry later?' }))
    .toMatchObject({ id: first.id, reused: true, status: 'sent' })
})

it('withdraws an unsent progress question when the final result carries that same question', async () => {
  const { ticket } = await host.acceptedTicket(feishu('102', '@bot inspect this'))
  host.runtime.engine.report(ticket.id, { state: 'progress', summary: 'Need input.', question: 'Retry later?' })
  const attention = host.runtime.engine.reply({ purpose: 'attention', ticketId: ticket.id, question: 'Retry later?', text: 'Retry later?' })
  host.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Provider unavailable.', question: 'Retry later?' })
  const result = host.runtime.engine.reply({ purpose: 'result', ticketId: ticket.id, question: 'Retry later?', text: 'Provider unavailable. Retry later?' })
  expect(host.runtime.store.replyStatus(attention.id)).toBeUndefined()
  await host.runtime.sendReplies()
  expect(host.runtime.store.replyStatus(result.id)).toBe('sent')
  expect(host.runtime.engine.reply({ purpose: 'attention', ticketId: ticket.id, question: 'Retry later?', text: 'Retry later?' }).id).toBe(result.id)
})

describe('external deployment notices after executor resume', () => {
  const eventId = '/r/x'
  const writeState = (ticket: Ticket, step: string, status: string, run?: string) => {
    writeFileSync(join(ticket.execution!.directory, 'DEPLOY_STATE.json'),
      JSON.stringify({ step, status, at: new Date().toISOString(), new: eventId, run, detail: 'acceptance failed' }))
  }
  const receiptId = (ticket: Ticket) => key('deploy-notice', ticket.id, eventId)
  const expectResumed = (ticket: Ticket) => {
    const after = host.runtime.store.tickets.get(ticket.id)!
    expect(after.ended).toBeUndefined()
    expect(after.assignments.length).toBeGreaterThanOrEqual(2)
    expect(after.assignments[0]).toMatchObject({ id: ticket.assignments[0]!.id, state: 'ended', endedReason: 'hostRestarted' })
    expect(after.assignments.at(-1)!.state).toBe('running')
    expect(after.inputs.some(input => input.kind === 'text' && input.text.includes('The host restarted'))).toBe(true)
  }

  it('re-reads a deployment that completes after resume and sends one receipt while the worker resumes', async () => {
    const { ticket, trigger } = await host.acceptedTicket(feishu('111', '@bot 修复部署失败通知'))
    writeState(ticket, 'restarting', 'running')
    host.runtime.executor.resume()
    await host.runtime.idle()
    expect(host.runtime.store.receipts.get(receiptId(ticket))).toBeUndefined()
    expect(host.runtime.effects.pending('deployWatch', ticket.id)).toBe(true)
    expectResumed(ticket)

    writeState(ticket, 'complete', 'success')
    host.runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind='deployWatch'").run()
    host.runtime.effects.kick()
    await host.runtime.effects.idle()
    await host.runtime.idle()
    await host.runtime.sendReplies()
    expect(host.runtime.store.receipts.get(receiptId(ticket))).toMatchObject({ kind: 'reply', ticketId: ticket.id,
      status: 'sent', channel: trigger.channel, text: expect.stringContaining('外部部署已完成') })
    expect(host.runtime.effects.pending('deployWatch', ticket.id)).toBe(false)
    expectResumed(ticket)
  })

  it('keeps rolling_back pending without a premature failure receipt', async () => {
    const { ticket } = await host.acceptedTicket(feishu('112', '@bot 修复回滚通知'))
    writeState(ticket, 'rolling_back', 'running')
    host.runtime.executor.resume()
    await host.runtime.idle()
    await host.runtime.sendReplies()
    expect(host.runtime.store.receipts.get(receiptId(ticket))).toBeUndefined()
    expect(host.runtime.effects.pending('deployWatch', ticket.id)).toBe(true)
    expectResumed(ticket)
  })

  it('reports a terminal rollback failure accurately', async () => {
    const { ticket } = await host.acceptedTicket(feishu('113', '@bot 修复回滚通知'))
    writeState(ticket, 'rolled_back', 'failure')
    host.runtime.executor.resume()
    await host.runtime.idle()
    await host.runtime.sendReplies()
    expect(host.runtime.store.receipts.get(receiptId(ticket))).toMatchObject({ status: 'sent',
      text: expect.stringContaining('回滚也未成功') })
    expectResumed(ticket)
  })

  it('sends only one receipt when a settled deployment is observed on two resumes', async () => {
    const { ticket } = await host.acceptedTicket(feishu('114', '@bot 修复部署通知'))
    writeState(ticket, 'complete', 'success')
    host.runtime.executor.resume()
    await host.runtime.idle()
    host.runtime.executor.resume()
    await host.runtime.idle()
    await host.runtime.sendReplies()
    const receipts = host.runtime.store.db.prepare("SELECT id FROM outbox WHERE id = ?").all(receiptId(ticket))
    expect(receipts).toHaveLength(1)
    expect(host.runtime.store.receipts.get(receiptId(ticket))).toMatchObject({ status: 'sent' })
    expectResumed(ticket)
  })

  it('resumes normally when the ticket has no deployment state', async () => {
    const { ticket } = await host.acceptedTicket(feishu('115', '@bot resume deployment'))
    host.runtime.executor.resume()
    await host.runtime.idle()
    expect(host.runtime.store.receipts.get(receiptId(ticket))).toBeUndefined()
    expect(host.runtime.effects.pending('deployWatch', ticket.id)).toBe(false)
    expectResumed(ticket)
  })

  it('sends a bounded deployment notice with its result and ticket number for a long title', async () => {
    const { ticket } = await host.acceptedTicket(feishu('116', '@bot resume deployment'))
    ticket.title = 'word '.repeat(200)
    host.runtime.store.tickets.save(ticket)
    writeState(ticket, 'rolled_back', 'failure')
    expect(() => host.runtime.executor.resume()).not.toThrow()
    await host.runtime.idle()
    await host.runtime.sendReplies()
    expectResumed(ticket)
    const receipt = host.runtime.store.receipts.get(receiptId(ticket))!
    expect(receipt).toMatchObject({ status: 'sent' })
    expect(wordCount(receipt.text)).toBeLessThanOrEqual(IM_WORDS)
    expect(receipt.text).toContain('The external deployment failed and rollback also failed; manual intervention is required')
    expect(receipt.text).toContain(ticket.shortId!)
  })

  it('retries transient unreadable state and sends exactly one receipt after recovery', async () => {
    const { ticket } = await host.acceptedTicket(feishu('117', '@bot resume deployment'))
    writeFileSync(join(ticket.execution!.directory, 'DEPLOY_STATE.json'), '{bad json')
    host.runtime.executor.resume()
    await host.runtime.idle()
    await host.runtime.sendReplies()
    expect(host.runtime.effects.pending('deployWatch', ticket.id)).toBe(true)
    expect(host.runtime.store.receipts.get(receiptId(ticket))).toBeUndefined()
    expectResumed(ticket)

    writeState(ticket, 'complete', 'success')
    host.runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind='deployWatch'").run()
    host.runtime.effects.kick()
    await host.runtime.effects.idle()
    await host.runtime.idle()
    await host.runtime.sendReplies()
    expect(host.runtime.store.receipts.get(receiptId(ticket))).toMatchObject({ status: 'sent',
      text: expect.stringContaining('The external deployment completed') })
    expect(host.runtime.store.db.prepare('SELECT id FROM outbox WHERE id = ?').all(receiptId(ticket))).toHaveLength(1)
    expect(host.runtime.effects.pending('deployWatch', ticket.id)).toBe(false)
    expectResumed(ticket)
  })

  it.each([
    { label: 'immediately settled state', initialStep: 'complete', deferred: false },
    { label: 'a deployment that settles after resume', initialStep: 'restarting', deferred: true },
  ])('retries a transient notice enqueue failure for $label without interrupting worker recovery', async ({ initialStep, deferred }) => {
    const { ticket } = await host.acceptedTicket(feishu('119', '@bot resume deployment'))
    writeState(ticket, initialStep, initialStep === 'complete' ? 'success' : 'running')
    const engine = host.runtime.engine
    const deployOutcome = engine.deployOutcome.bind(engine)
    let failuresRemaining = 1
    engine.deployOutcome = (ticketId, notice) => {
      if (failuresRemaining) {
        failuresRemaining--
        throw new Error('transient outbox enqueue failure')
      }
      deployOutcome(ticketId, notice)
    }

    expect(() => host.runtime.executor.resume()).not.toThrow()
    await host.runtime.idle()
    expectResumed(ticket)

    if (deferred) {
      expect(host.runtime.effects.pending('deployWatch', ticket.id)).toBe(true)
      expect(host.runtime.store.receipts.get(receiptId(ticket))).toBeUndefined()
      writeState(ticket, 'complete', 'success')
      host.runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind='deployWatch'").run()
      host.runtime.effects.kick()
      await host.runtime.effects.idle()
      expect(host.runtime.effects.pending('deployWatch', ticket.id)).toBe(true)
      expect(host.runtime.store.receipts.get(receiptId(ticket))).toBeUndefined()

      host.runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind='deployWatch'").run()
      host.runtime.effects.kick()
      await host.runtime.effects.idle()
    }

    await host.runtime.idle()
    await host.runtime.sendReplies()
    expect(host.runtime.store.receipts.get(receiptId(ticket))).toMatchObject({ status: 'sent' })
    expect(host.runtime.store.db.prepare('SELECT id FROM outbox WHERE id = ?').all(receiptId(ticket))).toHaveLength(1)
    expect(host.runtime.effects.pending('deployWatch', ticket.id)).toBe(false)
    expect(failuresRemaining).toBe(0)
    expectResumed(ticket)
  })

  it('sends two receipts for two runs deploying the same release path', async () => {
    const { ticket } = await host.acceptedTicket(feishu('118', '@bot resume deployment'))
    for (const run of ['run-1', 'run-2']) {
      writeState(ticket, 'complete', 'success', run)
      host.runtime.executor.resume()
      await host.runtime.idle()
      await host.runtime.sendReplies()
      expect(host.runtime.store.receipts.get(key('deploy-notice', ticket.id, run))).toMatchObject({ status: 'sent' })
    }
    // Observing the second run again must still deduplicate it.
    host.runtime.executor.resume()
    await host.runtime.idle()
    await host.runtime.sendReplies()
    const receipts = host.runtime.store.db.prepare('SELECT id FROM outbox WHERE id IN (?, ?)')
      .all(key('deploy-notice', ticket.id, 'run-1'), key('deploy-notice', ticket.id, 'run-2'))
    expect(receipts).toHaveLength(2)
    expectResumed(ticket)
  })
})
