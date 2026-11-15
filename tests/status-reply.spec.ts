import { afterEach, expect, it, vi } from 'vitest'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'
import { key } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const followup = (id: string, text = '确认一下现在是否在正常工作') => feishu(id, text, { mentions: [], root_id: 'om_1' })
const status = (ticketId: string, triggerId: string) => ({ purpose: 'answer' as const, ticketId, triggerId, statusOnly: true, text: '一切正常，已经成功完成。' })

it('answers a busy Ticket status question immediately through native Reply/Outbox in its own Feishu thread', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix this'))
  const question = followup('2')
  h.runtime.receive(question); await h.runtime.idle()
  expect(h.agents.get(sessionId)!.status).toBe('running')
  expect(h.relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'follow_up', trigger_id: question.id,
    note: expect.stringContaining('status_only true') })
  expect(h.runtime.store.tickets.get(ticket.id)?.answers).toBeUndefined()
  const sent = await h.runTool(h.runtime.masterId, 'orchestrator_reply', {
    purpose: 'answer', ticket_id: ticket.id, trigger_id: question.id, status_only: true, text: '运行正常，已经完成。',
  })
  expect(sent).toEqual({ status: 'sent' })
  const receipt = h.runtime.store.receipts.get(key('status', ticket.id, question.id))!
  expect(receipt).toMatchObject({ status: 'sent', channel: question.channel, ticketId: ticket.id, kind: 'reply', replyInThread: true })
  expect(receipt.text).toContain('仍在运行；尚不能确认执行正常或任务成功')
  expect(receipt.text).not.toContain('运行正常，已经完成')
  expect(receipt.channel.thread).toBe(`feishu:${CHAT}`)
  expect(receipt.channel.address.messageId).toBe('om_2')
  expect(h.candidates()).not.toContain(question.id)
})

it('answers a status query from the main private chat without changing the Ticket or starting work', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot inspect README', { chat_type: 'p2p', mentions: [] }))
  const question = feishu('2', '查询工单的真实状态', { chat_type: 'p2p', mentions: [] })
  h.runtime.store.triggers.save(question)
  const assignments = h.runtime.store.tickets.get(ticket.id)!.assignments.map(item => item.id)
  const ticketIds = h.runtime.store.tickets.list().map(item => item.id)

  const reply = h.runtime.engine.reply(status(ticket.id, question.id))
  const receipt = h.runtime.store.receipts.get(reply.id)!
  expect(receipt).toMatchObject({ channel: question.channel, ticketId: ticket.id, kind: 'reply', replyInThread: false })
  expect(receipt.text).toContain('仍在运行；尚不能确认执行正常或任务成功')
  expect(h.runtime.store.tickets.list().map(item => item.id)).toEqual(ticketIds)
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.map(item => item.id)).toEqual(assignments)
  expect(h.agents.get(sessionId)!.status).toBe('running')
})

it('deduplicates status answers across wording and state changes, while a new question gets current state', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix this'))
  const question = followup('2'); h.runtime.receive(question); await h.runtime.idle()
  const first = h.runtime.engine.reply(status(ticket.id, question.id))
  await h.runtime.sendReplies()
  const lark = vi.mocked(Commands.prototype.lark); lark.mockClear()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Still working' })
  expect(h.runtime.engine.reply({ ...status(ticket.id, question.id), text: 'different' })).toMatchObject({ id: first.id, reused: true })
  await h.runtime.sendReplies()
  expect(lark.mock.calls).toHaveLength(0)
  expect(h.runtime.receive(question)).toBe('duplicate')
  const newer = followup('3'); h.runtime.receive(newer); await h.runtime.idle()
  h.runtime.engine.stopTicket(ticket.id)
  const second = h.runtime.engine.reply(status(ticket.id, newer.id))
  expect(second.id).not.toBe(first.id)
  expect(h.runtime.store.receipts.get(second.id)?.text).toContain('任务已停止')
  expect(h.runtime.store.receipts.get(second.id)?.text).not.toContain('运行正常')
})

it('retains a single pending status answer through pause and native Outbox delivery', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix this'))
  const question = followup('2'); h.runtime.receive(question); await h.runtime.idle()
  await h.runtime.settings.pause(true, 'panel')
  const reply = h.runtime.engine.reply(status(ticket.id, question.id))
  await h.runtime.sendReplies()
  expect(h.runtime.store.replyStatus(reply.id)).toBe('pending')
  expect(h.runtime.engine.reply(status(ticket.id, question.id))).toMatchObject({ reused: true, id: reply.id })
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.store.replyStatus(reply.id)).toBe('sent')
})

it('keeps technical answers gated and does not consume their worker authorization', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix this'))
  const question = followup('2', '测试通过了吗？')
  h.runtime.receive(question); await h.runtime.idle()
  const answer = { purpose: 'answer' as const, ticketId: ticket.id, triggerId: question.id, text: 'The test passed.' }
  expect(() => h!.runtime.engine.reply(answer)).toThrow('No worker answer')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'The test passed.', reply_to_trigger_id: question.id })
  h.runtime.engine.reply(status(ticket.id, question.id))
  expect(h.runtime.store.tickets.get(ticket.id)?.answers).toContain(question.id)
  const reply = h.runtime.engine.reply(answer)
  await h.runtime.sendReplies()
  expect(h.runtime.store.replyStatus(reply.id)).toBe('sent')
  expect(h.runtime.store.tickets.get(ticket.id)?.answers).not.toContain(question.id)
  expect(h.runtime.engine.reply(answer)).toMatchObject({ id: reply.id, reused: true })
})

it('refuses non-human, unrelated, context-only and non-answer status requests', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix this'))
  const other = feishu('7', 'unrelated', { sender_id: 'ou_guest' }); h.runtime.store.triggers.save(other)
  expect(() => h!.runtime.engine.reply(status(ticket.id, other.id))).toThrow('does not belong')
  const bot = { ...followup('8'), human: false }; h.runtime.store.triggers.save(bot)
  expect(() => h!.runtime.engine.reply(status(ticket.id, bot.id))).toThrow('original human question')
  await h.runTool(sessionId, 'orchestrator_thread_follow', { thread: `feishu:${CHAT}:om_9`, reason: 'Context only' })
  const context = feishu('10', 'status?', { mentions: [], root_id: 'om_9', sender_id: 'ou_guest' })
  h.runtime.receive(context); await h.runtime.idle()
  expect(() => h!.runtime.engine.reply(status(ticket.id, context.id))).toThrow('does not belong')
  const question = followup('11'); h.runtime.receive(question); await h.runtime.idle()
  expect(() => h!.runtime.engine.reply({ ...status(ticket.id, question.id), purpose: 'result' })).toThrow('original human question')
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'result', ticket_id: ticket.id, status_only: true, text: 'done' }))
    .rejects.toThrow()
})

it.each([
  ['queued', 'Queued; execution has not started.'],
  ['idle', 'Currently idle; this turn ended and awaits a follow-up, which does not mean background work is still running or that the task succeeded.'],
  ['delivery', 'Input delivery to the worker failed'],
] as const)('reports %s from current state in the question language', async (state, expected) => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix this'))
  const question = followup('2', 'Is this Ticket still working?')
  h.runtime.receive(question); await h.runtime.idle()
  const current = h.runtime.store.tickets.get(ticket.id)!
  if (state === 'queued') current.assignments.at(-1)!.state = 'pending'
  if (state === 'idle') current.assignments.at(-1)!.report = { state: 'waiting', summary: 'Waiting', at: new Date().toISOString() }
  if (state === 'delivery') current.delivery = { error: 'Input delivery failed', at: new Date().toISOString() }
  h.runtime.store.tickets.save(current)
  const reply = h.runtime.engine.reply(status(ticket.id, question.id))
  expect(h.runtime.store.receipts.get(reply.id)?.text).toContain(expected)
  expect(h.runtime.store.receipts.get(reply.id)?.text).not.toContain('任务状态')
})

it('routes an original-thread question about an ended Ticket to the Router without restarting its Worker', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot inspect this'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Inspection finished' })
  await h.runtime.idle()
  const count = h.runtime.store.tickets.get(ticket.id)!.assignments.length
  const question = followup('891', '这个工单状态如何？')
  h.runtime.receive(question); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(count)
  expect(h.runtime.store.triggers.disposition(question.id)?.fanout).toEqual([])
  h.runtime.engine.reply(status(ticket.id, question.id)); await h.runtime.sendReplies()
  expect(h.runtime.store.receipts.get(key('status', ticket.id, question.id))?.text).toContain('已记录为完成')
})
