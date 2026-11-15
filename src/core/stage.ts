/** Ticket stage classification and retry eligibility (docs/003). */
import { latestAssignment, waitsForPerson, type Ticket } from './model.ts'

/** The ticket's short number and title, or its title alone for historical tickets. */
export function ticketHeading(ticket: Pick<Ticket, 'shortId' | 'title'>, chinese: boolean): string {
  if (!ticket.shortId) return ticket.title
  return chinese ? `工单 ${ticket.shortId}｜${ticket.title}` : `Ticket ${ticket.shortId} | ${ticket.title}`
}

/** High-level execution stage of a ticket: waiting on a person, actively working or queued, idle between turns, or ended. */
export type TicketStage = { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' } | { stage: 'idle' } | { stage: 'ended' }

/** Classifies a ticket's stage; the rules follow the table in docs/003 in order, where the first matching row wins. */
export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.ended) return { stage: 'ended' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  const assignment = latestAssignment(ticket)
  const report = assignment?.report?.state
  if (report === 'ready') return { stage: 'person', action: 'review' }
  // A human follow-up after a blocked or failed report returns the ticket to the executor.
  if ((report === 'blocked' || report === 'failed') && waitsForPerson(ticket)) return { stage: 'person', action: report }
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' }
  if (report === 'waiting' || assignment.state === 'ended') return { stage: 'idle' }
  return { stage: 'working' }
}

/** True when an open ticket is stalled on a blocked/failed report without a newer human follow-up, or has a failed input delivery. */
export function canRetry(ticket: Ticket): boolean {
  return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery)
}

/**
 * The display key a ticket's current state maps to (see `STATUS_TEXT`): how it ended, or its open stage. Derived only from
 * native lifecycle facts, so a status answer or an ordinary receipt cannot claim a state the ticket does not actually hold.
 */
export function ticketStatusKey(ticket: Ticket): string {
  if (ticket.ended) return ticket.ended.outcome
  const stage = ticketStage(ticket)
  return stage.stage === 'person' ? `person/${stage.action}`
    : stage.stage === 'working' && stage.action ? 'working/queued' : stage.stage
}

/** User-facing text for each state key, in both interface languages; the one source for status answers and receipts. */
export const STATUS_TEXT: Readonly<Record<string, { zh: string; en: string }>> = {
  working: { zh: '仍在运行；尚不能确认执行正常或任务成功。', en: 'Still running; healthy execution or task success is not yet confirmed.' },
  'working/queued': { zh: '正在排队，尚未开始执行。', en: 'Queued; execution has not started.' },
  idle: { zh: '当前空闲；本轮已结束、等待人工跟进，不代表后台任务仍在执行，也不代表任务成功。', en: 'Currently idle; this turn ended and awaits a follow-up, which does not mean background work is still running or that the task succeeded.' },
  'person/delivery': { zh: '消息未能送达执行器，需要处理投递问题。', en: 'Input delivery to the worker failed and needs attention.' },
  'person/answer': { zh: '正在等待人工回答。', en: 'Waiting for a human answer.' },
  'person/review': { zh: '已报告可供审核，正在等待人工审核。', en: 'Reported ready for human review.' },
  'person/blocked': { zh: '执行受阻，正在等待人工处理。', en: 'Blocked; waiting for human action.' },
  'person/failed': { zh: '已报告执行失败，正在等待人工处理。', en: 'Execution was reported failed; waiting for human action.' },
  completed: { zh: '任务已记录为完成。', en: 'The task is recorded as completed.' },
  merged: { zh: '关联的 PR 已合并。', en: 'The associated PR has merged.' },
  closed: { zh: '关联的工作已关闭。', en: 'The associated work is closed.' },
  dropped: { zh: '任务已结束，无需继续处理。', en: 'The task ended with no further work.' },
  stopped: { zh: '任务已停止。', en: 'The task was stopped.' },
}

/** The state text for a ticket, in one language, from its native lifecycle facts. */
export function ticketStatusText(ticket: Ticket, language: 'zh' | 'en'): string {
  return (STATUS_TEXT[ticketStatusKey(ticket)] ?? { zh: '当前状态未知。', en: 'Current state is unknown.' })[language]
}

export interface TicketStatusCounts {
  executing: number;
  queued: number;
  waitingPerson: number;
  followUp: number;
  open: number;
  ended: number;
  hasOpen: boolean;
}

export function ticketStatusCounts(tickets: readonly Ticket[]): TicketStatusCounts {
  let executing = 0, queued = 0, waitingPerson = 0, followUp = 0, open = 0, ended = 0;
  for (const ticket of tickets) {
    if (ticket.ended) {
      ended++;
      continue;
    }
    const s = ticketStage(ticket);
    if (s.stage === 'person') {
      waitingPerson++;
    } else if (s.stage === 'idle') {
      followUp++;
    } else if (s.stage === 'working' && s.action === 'queued') {
      queued++;
    } else {
      executing++;
    }
    open++;
  }
  return { executing, queued, waitingPerson, followUp, open, ended, hasOpen: open > 0 };
}
