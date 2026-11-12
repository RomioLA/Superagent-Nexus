import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { composeTicketReceipt, receiptStatusText } from '../src/app/receipts.ts'
import { key, shortDayKey, shortTicketId, UserError, type Ticket } from '../src/core/index.ts'
import { CHAT, MEMBER, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

const ticket = (over: Record<string, unknown>): Ticket => ({
  id: 'internal-uuid-0001', shortId: '26111201', title: 'Router 自动模型分配', decisionId: 'd',
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'addressed' }, actor: { source: 'feishu', id: 'ou' }, scope: 's' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'tr', triggerIds: ['tr'] },
  ...over,
}) as unknown as Ticket

it('builds YYMMDD day keys in the project timezone and extends the sequence past 99', () => {
  expect(shortDayKey('2026-11-12T12:47:56.481Z')).toBe('261112') // 20:47 in Asia/Shanghai
  expect(shortDayKey('2026-11-11T16:00:00.000Z')).toBe('261112') // already the next day in Shanghai
  expect(shortDayKey('2026-11-11T15:59:59.000Z')).toBe('261111')
  expect(shortTicketId('261112', 1)).toBe('26111201')
  expect(shortTicketId('261112', 99)).toBe('26111299')
  expect(shortTicketId('261112', 100)).toBe('261112100')
  expect(shortTicketId('261112', 101)).toBe('261112101')
})

it('composes a receipt with the number, title and true state, and never claims deployment from local work', () => {
  const localDone = ticket({ ended: { at: '', by: 'worker', outcome: 'completed' }, execution: { project: { repository: 'r', localOnly: true } } })
  const text = composeTicketReceipt(localDone, '已加入按任务性质选择执行器的规则，相关测试通过。', true)
  expect(text).toContain('工单 26111201｜Router 自动模型分配')
  expect(text).toContain('状态：本地开发已完成，尚未部署。')
  expect(text).toContain('已加入按任务性质选择执行器的规则，相关测试通过。')
  expect(text).not.toContain('internal-uuid-0001')
  // The same complete ticket on a deployable project does not claim deployment either.
  expect(receiptStatusText(ticket({ ended: { at: '', by: 'worker', outcome: 'completed' } }), true)).toBe('任务已完成。')
  expect(composeTicketReceipt(ticket({ shortId: undefined }), '历史工单', true)).toMatch(/^Router 自动模型分配\n/)
})

it('assigns a stable, unique short number to each new ticket and resolves it on the ticket card', async () => {
  h = await startRuntime()
  const first = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const second = await h.acceptedTicket(feishu('2', '@bot 再修一个'))
  const a = h.runtime.store.tickets.get(first.ticket.id)!
  const b = h.runtime.store.tickets.get(second.ticket.id)!
  expect(a.shortId).toMatch(/^\d{8}$/)
  expect(b.shortId).toMatch(/^\d{8}$/)
  expect(a.shortId).not.toBe(b.shortId)
  expect(a.shortId!.slice(0, 6)).toBe(b.shortId!.slice(0, 6))
  expect(Number(b.shortId!.slice(6))).toBe(Number(a.shortId!.slice(6)) + 1)
  // The short number is a stored label; the internal id stays the primary key.
  expect(a.id).not.toBe(a.shortId)
  const card = await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `ticket/${a.shortId}` }) as { ticket_id: string; short_id: string }
  expect(card).toMatchObject({ ticket_id: a.id, short_id: a.shortId })
})

it('uses the persisted short number and title in the first acknowledgement, status and final result receipt', async () => {
  h = await startRuntime()
  const { ticket: created, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const heading = `工单 ${created.shortId}｜${created.title}`
  const acknowledgement = h.runtime.store.receipts.get(key('ack', created.origin.triggerId))!
  expect(acknowledgement.text).toBe(`${heading}\n\n收到，修复回归。`)
  expect(h.runtime.engine.reply({ purpose: 'acknowledgement', ticketId: created.id, triggerId: created.origin.triggerId,
    text: '重复确认' })).toMatchObject({ reused: true, id: acknowledgement.id })
  await h.runtime.sendReplies()
  const firstReplies = vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args as string[])
    .filter(args => args[1] === '+messages-reply')
  expect(firstReplies).toHaveLength(1)
  expect(firstReplies[0]).toContain(acknowledgement.text)
  const question = feishu('5', `@bot ${created.shortId} 做完了吗`, { root_id: 'om_9' })
  h.runtime.receive(question); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: created.id, trigger_id: question.id,
    purpose: 'answer', status_only: true, text: '忽略这段文字' })
  expect(h.runtime.store.receipts.get(key('status', created.id, question.id))?.text).toContain(heading)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '修好了，相关测试通过。' })
  await h.runtime.idle()
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: created.id, purpose: 'result', text: '修好了，相关测试通过。' })).toEqual({ status: 'sent' })
  const current = h.runtime.store.tickets.get(created.id)!
  const markdowns = vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args as string[])
    .filter(args => args[1] === '+messages-reply').map(args => args[args.indexOf('--markdown') + 1])
  const receipt = markdowns.find(text => text?.includes('修好了'))!
  expect(receipt).toContain(`工单 ${current.shortId}｜${current.title}`)
  expect(receipt).toContain(`状态：${receiptStatusText(current, true)}`)
  expect(receipt).not.toContain(created.id)
})

it('offers only the mandate requester\'s short-numbered tickets, comparing both source and id', async () => {
  h = await startRuntime()
  const { ticket: created } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const short = h.runtime.store.tickets.get(created.id)!.shortId!
  // Sharing an origin does not share the requester identity: the mandate is authoritative.
  h.runtime.store.tickets.save({ ...created, id: 'another-user', shortId: '26111202',
    mandate: { ...created.mandate, actor: { source: 'feishu', id: 'ou_bob' } } })
  h.runtime.store.tickets.save({ ...created, id: 'another-source', shortId: '26111203',
    mandate: { ...created.mandate, actor: { source: 'github', id: MEMBER } } })
  const question = feishu('5', `@bot ${short} 26111202 26111203 做完了吗`, { root_id: 'om_9' })
  h.runtime.receive(question); await h.runtime.idle()
  const candidate = h.relays(h.runtime.masterId).filter(relay => relay.kind === 'candidate').at(-1)!
  expect(candidate.referenced_tickets).toEqual([expect.objectContaining({ ticket_id: created.id, short_id: short })])
})

it.each([99, 100, 101])('locates the exact full short number for ticket %s without matching part of a longer number', async sequence => {
  h = await startRuntime()
  const { ticket: created } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const shortId = shortTicketId('261112', sequence)
  h.runtime.store.tickets.save({ ...created, shortId })
  const question = feishu('5', `@bot 工单 ${shortId} 做完了吗？`, { root_id: 'om_9' })
  h.runtime.receive(question); await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).filter(relay => relay.kind === 'candidate').at(-1)?.referenced_tickets)
    .toEqual([expect.objectContaining({ ticket_id: created.id, short_id: shortId })])
  const longer = feishu('6', `@bot 9${shortId}9 做完了吗？`, { root_id: 'om_10' })
  h.runtime.receive(longer); await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).filter(relay => relay.kind === 'candidate').at(-1)?.referenced_tickets).toBeUndefined()
})

it.each([
  ['selected', true], ['other', false], [undefined, false],
] as const)('filters short-number candidates by selected project %s', async (projectId, included) => {
  h = await startRuntime()
  const { ticket: created } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.store.tickets.save({ ...created, execution: { ...created.execution!, project: { repository: 'acme/widgets' } } })
  const question = feishu('5', `@bot ${created.shortId} 做完了吗`, { root_id: 'om_9' })
  question.meta = { ...question.meta, projectRequired: true, projectId, projects: [
    { id: 'selected', name: 'Widgets', status: 'test', repository: 'acme/widgets' },
    { id: 'other', name: 'Other', status: 'test', repository: 'acme/other' },
  ] }
  h.runtime.receive(question); await h.runtime.idle()
  const candidate = h.relays(h.runtime.masterId).filter(relay => relay.kind === 'candidate').at(-1)!
  if (included) expect(candidate.referenced_tickets).toEqual([expect.objectContaining({ ticket_id: created.id })])
  else expect(candidate.referenced_tickets).toBeUndefined()
})

it.each(['waiting', 'completed'] as const)('answers the requester across Feishu topics from persisted %s state without waking or changing the ticket', async state => {
  h = await startRuntime()
  const { ticket: created, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.engine.report(created.id, { state: state === 'completed' ? 'ready' : 'waiting', summary: '已有记录' })
  await h.runtime.idle()
  h.agents.get(sessionId)!.status = 'idle'
  h.deliveries.mockClear()
  const before = h.runtime.store.tickets.get(created.id)!
  const question = feishu('5', `@bot ${before.shortId} 做完了吗`, { root_id: 'om_9' })
  h.runtime.receive(question); await h.runtime.idle()
  const request = { ticket_id: created.id, trigger_id: question.id, purpose: 'answer', status_only: true, text: '已经部署了' }
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_reply', request)).toEqual({ status: 'sent' })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_reply', request)).toEqual({ status: 'sent' })
  const receipt = h.runtime.store.receipts.get(key('status', created.id, question.id))!
  expect(receipt).toMatchObject({ channel: question.channel, ticketId: created.id, ticketShortId: before.shortId })
  expect(receipt.text).toContain(before.shortId!)
  expect(receipt.text).toContain(state === 'completed' ? '任务已记录为完成' : '当前空闲')
  expect(receipt.text).not.toContain('已经部署了')
  expect(h.runtime.store.tickets.get(created.id)).toEqual(before)
  expect(h.runtime.store.threads.get(`feishu:${CHAT}:om_9`)?.subscriptions).toEqual([])
  expect(h.relays(sessionId)).toEqual([])
  expect(h.agents.get(sessionId)!.status).toBe('idle')
})

it.each([
  { source: 'feishu', id: 'ou_bob' }, { source: 'github', id: MEMBER },
])('refuses cross-topic status and attachment from $source:$id without disclosing or mutating the ticket', async actor => {
  h = await startRuntime()
  const { ticket: created } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const before = h.runtime.store.tickets.get(created.id)!
  const question = { ...feishu('5', `@bot ${before.shortId} 做完了吗，继续修`, { root_id: 'om_9' }), actor }
  h.runtime.receive(question); await h.runtime.idle()
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: created.id, trigger_id: question.id,
    purpose: 'answer', status_only: true, text: '请给出状态' })).rejects.toThrow(new UserError('notReached'))
  expect(h.runtime.store.receipts.get(key('status', created.id, question.id))).toBeUndefined()
  await expect(h.route({ kind: 'attach', ticket_id: created.id, trigger_id: question.id })).rejects.toThrow('does not belong')
  expect(h.runtime.store.tickets.get(created.id)).toEqual(before)
  expect(h.runtime.store.threads.get(`feishu:${CHAT}:om_9`)?.subscriptions).toEqual([])
})
