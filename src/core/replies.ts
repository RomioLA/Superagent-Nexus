/** The Engine's messages to Channels, each by the rule that allows it. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, sameActor, threadKey, ticketOutcome } from './model.ts'
import type { ChannelRef, Decision, DeployNotice, Ticket, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'
import { ticketHeading, ticketStatusText } from './stage.ts'
import { IM_WORDS, wordCount } from '../infra/text.ts'

/** Shortens an optional message part against the complete IM text, preserving the fixed content. */
function fitImPart(value: string, compose: (part: string) => string): string {
  if (wordCount(compose(value)) <= IM_WORDS) return value
  const characters = Array.from(value)
  let low = 0, high = characters.length
  const prefix = (length: number): string => length ? characters.slice(0, length).join('').trimEnd() + '…' : ''
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (wordCount(compose(prefix(middle))) <= IM_WORDS) low = middle
    else high = middle - 1
  }
  return prefix(low)
}

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * or the ticket's current `question` for a person (`attention`). When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string; statusOnly?: boolean }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, and its question for a person, each only when its rule allows it, under a deterministic id
 * that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets asks it for the acknowledgement
 * an accept carries, and Assignments asks it to withdraw a question a report replaced.
 */
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
   * written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
   * result to the conversation where the ticket started (ready, explicit failed/blocked, or an ended ticket), including
   * its current human question when supplied. An open question never suppresses a deliverable result.
   * Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
   * records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request) : this.answer(request)
  }
  /**
   * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
   * and a person wrote it.
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (!trigger.channel || !trigger.human) return
    const chinese = /\p{Script=Han}/u.test(trigger.text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(trigger.text)
    this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel,
      text: `${ticketHeading(this.require(ticketId), chinese)}\n\n${text}`, kind: 'acknowledgement', ticketId })
  }
  /**
   * Queue one failure receipt to the conversation an explicit request came from when its Eval ended `unavailable` after
   * the retries, so its sender learns it was not accepted and can send it again. Only a person's request the gate admits
   * explicitly gets one; the deterministic id keeps a repeated record of the same Decision from queueing it twice.
   */
  unaccepted(decision: Decision, trigger: Trigger): void {
    if (!trigger.human || !trigger.channel) return
    const thread = this.thread(trigger.threads[0]!)
    const gate = this.policy().gate(trigger, thread, this.ticketsOnThread(thread))
    if (!gate.admissible || gate.strength !== 'explicit') return
    const chinese = /\p{Script=Han}/u.test(trigger.text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(trigger.text)
    const text = chinese
      ? '请求未被接收：系统连续处理超时，已停止自动尝试，未创建工单。请重新发送以重试。'
      : 'The request was not accepted: processing timed out repeatedly, so the automatic attempt stopped without creating a ticket. Please send it again to retry.'
    this.options.outbox.send({ id: key('unaccepted', decision.id, trigger.id), channel: trigger.channel, text, kind: 'reply' })
  }
  /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id })
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.statusOnly) return this.statusAnswer(request, ticket, trigger)
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const state = ticket && latestAssignment(ticket)?.report?.state
      const reported = !!ticket && liveTicket(ticket) && (state === 'ready'
        || (ticket.mandate.strength === 'explicit' && (state === 'failed' || state === 'blocked')))
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || outcome === 'stopped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // Attention replies must match the ticket's currently open question text.
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    // A consolidated result already queued this question through the same durable Outbox; do not ask it separately.
    const covered = attention?.resultReplyId
    const coveredStatus = covered && this.options.outbox.status(covered)
    if (covered && coveredStatus) return { id: covered, status: coveredStatus, reused: true }
    if (request.purpose === 'result' && request.question && ticket?.attention?.question !== request.question)
      throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const id = request.purpose === 'result' && ticket
      ? key('result', ticket.id, latestAssignment(ticket)?.id ?? '', ticket.ended?.outcome ?? latestAssignment(ticket)?.report?.state ?? '',
        ticket.ended?.at ?? latestAssignment(ticket)?.report?.at ?? ticket.updatedAt)
      : attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({ id, channel, text: request.text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {},
      ...ticket?.shortId ? { ticketShortId: ticket.shortId } : {}, ...request.purpose === 'result' ? { purpose: 'result' as const } : {} })
    if (request.purpose === 'result' && ticket?.attention && request.question === ticket.attention.question) {
      // Keep the actionable question, but point its delivery at the result instead of creating a second notification.
      this.withdrawAttention(ticket.attention.id)
      ticket.attention.resultReplyId = id
      this.repo.tickets.save(ticket)
    }
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** Answer only from persisted lifecycle state, without authorizing or consuming a worker's technical answer. */
  private statusAnswer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>, ticket?: Ticket, trigger?: Trigger): Reply {
    if (request.purpose !== 'answer' || !trigger?.human) throw new UserError('notQuestion')
    if (!ticket || (!this.reaches(ticket, trigger, false) && !sameActor(ticket.mandate.actor, trigger.actor))) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('noChannel')
    const id = key('status', ticket.id, trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing) {
      const chinese = /\p{Script=Han}/u.test(trigger.text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(trigger.text)
      const detail = ticketStatusText(ticket, chinese ? 'zh' : 'en')
      const inThread = trigger.source === 'feishu' && ['rootId', 'parentId', 'threadId']
        .some(field => typeof trigger.meta[field] === 'string' && trigger.meta[field] !== '')
      this.options.outbox.send({ id, channel: trigger.channel, kind: 'reply', ticketId: ticket.id,
        ...ticket.shortId ? { ticketShortId: ticket.shortId } : {},
        ...trigger.source === 'feishu' ? { replyInThread: inThread } : {},
        text: `${ticketHeading(ticket, chinese)}\n\n` + (chinese ? '当前记录状态：' : 'Recorded status: ') + detail })
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }

  /**
   * Queues a deployment outcome to the ticket's origin Feishu channel once per deployment, across assignments.
   * The notice leaves the ticket's report and stage to its resumed worker.
   */
  deployNotice(ticket: Ticket, notice: DeployNotice): void {
    const trigger = this.source(ticket)
    if (trigger?.source !== 'feishu' || !trigger.channel) return
    const chinese = /\p{Script=Han}/u.test(trigger.text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(trigger.text)
    const inThread = ['rootId', 'parentId', 'threadId'].some(field => typeof trigger.meta[field] === 'string' && trigger.meta[field] !== '')
    const summaries = {
      succeeded: chinese ? '外部部署已完成' : 'The external deployment completed',
      rolled_back: chinese ? '外部部署失败，已回滚到原版本' : 'The external deployment failed and rolled back to the original version',
      rollback_failed: chinese ? '外部部署失败，回滚也未成功，需要人工处理' : 'The external deployment failed and rollback also failed; manual intervention is required',
      aborted: chinese ? '外部部署失败，已中止（未回滚）' : 'The external deployment failed and was aborted (without rollback)',
    }
    const summary = summaries[notice.result]
    const compose = (title: string, detail: string): string => `${ticketHeading({ ...ticket, title }, chinese)}\n\n${summary}`
      + (detail ? `${chinese ? '：' : ': '}${detail}` : '')
    const detail = fitImPart(notice.detail, part => compose(ticket.title, part))
    const title = fitImPart(ticket.title, part => compose(part, detail))
    this.options.outbox.send({ id: key('deploy-notice', ticket.id, notice.eventId), channel: trigger.channel, kind: 'reply',
      ticketId: ticket.id, ...(ticket.shortId ? { ticketShortId: ticket.shortId } : {}), ...(inThread ? { replyInThread: true } : {}),
      text: compose(title, detail) })
  }

  /**
   * Queue the one batch summary for a split request once every Ticket it created has ended. A request split into several
   * independent Tickets has no single result receipt; this reuses the split Decision's `audit.splitTickets`, the Tickets,
   * their HarnessRun records and the Outbox, and sends one message to the source conversation, at most once per batch.
   */
  batchSummary(ticketId: string): void {
    const ended = this.repo.tickets.get(ticketId)
    const trigger = ended && this.source(ended)
    if (!ended?.ended || !trigger) return
    const split = this.repo.decisions.byThread(threadKey(trigger.threads[0]!))
      .find(decision => Array.isArray(decision.audit?.splitTickets)
        && (decision.audit!.splitTickets as unknown[]).includes(ticketId))
    const ids = split && Array.isArray(split.audit?.splitTickets) ? split.audit!.splitTickets as string[] : []
    if (!split || ids.length < 2) return
    const tickets = ids.map(id => this.repo.tickets.get(id)).filter((ticket): ticket is Ticket => !!ticket)
    // Wait until every Ticket of the batch has ended; the last ending sends the one summary.
    if (tickets.length !== ids.length || tickets.some(ticket => !ticket.ended)) return
    const id = key('batch-summary', split.id)
    if (this.options.outbox.status(id)) return
    if (!trigger.channel) return
    const chinese = /\p{Script=Han}/u.test(trigger.text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(trigger.text)
    this.options.outbox.send({ id, channel: trigger.channel, kind: 'reply', text: batchSummaryText(tickets, trigger, chinese) })
  }
}

/** One batch summary from the ended Tickets: results, Harness/models, verifiable usage, switches, and people's next steps. */
function batchSummaryText(tickets: readonly Ticket[], trigger: Trigger, chinese: boolean): string {
  const label = (ticket: Ticket): string => ticket.shortId ?? ticket.id.slice(0, 8)
  const outcome = (ticket: Ticket): string => ticket.ended?.outcome ?? latestAssignment(ticket)?.report?.state ?? 'ended'
  const harness = new Set<string>()
  let calls = 0, tokens = 0, cost = 0, knownCost = 0, runs = 0
  const switches: string[] = []
  for (const ticket of tickets) {
    const spec = ticket.execution?.harness
    if (spec) harness.add(`${spec.harness}${spec.model ? '/' + spec.model : ''}`)
    for (const run of ticket.execution?.harnessRuns ?? []) {
      runs++
      calls += run.usage?.modelCalls ?? 0
      tokens += run.usage?.totalTokens ?? 0
      if (typeof run.usage?.costUSD === 'number') { cost += run.usage.costUSD; knownCost++ }
      for (const model of run.models ?? []) harness.add(`${run.harness}/${model}`)
    }
    for (const change of ticket.execution?.continuations ?? []) {
      const before = change.before ? `${change.before.harness}${change.before.model ? '/' + change.before.model : ''}` : '?'
      const after = change.after ? `${change.after.harness}${change.after.model ? '/' + change.after.model : ''}` : '?'
      if (before !== after) switches.push(`${before}→${after}`)
    }
  }
  const needsPerson = tickets.filter(ticket => ['blocked', 'failed'].includes(latestAssignment(ticket)?.report?.state ?? '')
    || ticket.ended?.outcome === 'stopped')
    .map(ticket => `${label(ticket)} ${latestAssignment(ticket)?.report?.state ?? ticket.ended?.outcome ?? ''}`)
  const unknownCost = runs - knownCost
  if (chinese) return [
    `批次汇总（原请求 ${trigger.id.slice(0, 8)}，共 ${tickets.length} 个工单）`,
    `工单：${tickets.map(ticket => `${label(ticket)} ${ticket.title}（${outcome(ticket)}）`).join('；')}`,
    `Harness/模型：${[...harness].join('、') || '未记录'}`,
    `调用/费用：modelCalls=${calls}，tokens=${tokens}，cost≈$${cost.toFixed(4)}${unknownCost ? `（${unknownCost} 次费用未知）` : ''}`,
    `模型切换：${switches.length ? switches.join('；') : '无记录'}`,
    `需人工：${needsPerson.length ? needsPerson.join('；') : '无'}`,
  ].join('\n')
  return [
    `Batch summary (request ${trigger.id.slice(0, 8)}, ${tickets.length} tickets)`,
    `Tickets: ${tickets.map(ticket => `${label(ticket)} ${ticket.title} (${outcome(ticket)})`).join('; ')}`,
    `Harness/model: ${[...harness].join(', ') || 'not recorded'}`,
    `Calls/cost: modelCalls=${calls}, tokens=${tokens}, cost≈$${cost.toFixed(4)}${unknownCost ? ` (${unknownCost} runs with cost unknown)` : ''}`,
    `Model switches: ${switches.length ? switches.join('; ') : 'not recorded'}`,
    `Needs a person: ${needsPerson.length ? needsPerson.join('; ') : 'none'}`,
  ].join('\n')
}
