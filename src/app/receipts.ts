/** Ordinary user-facing receipts: the ticket's number and title, its true state from native facts, and the result body. */
import { IM_WORDS, wordCount } from '../infra/text.ts'
import { ticketHeading, ticketStatusText, type Ticket } from '../core/index.ts'
export { ticketHeading } from '../core/index.ts'

/** Whether text is Chinese rather than Japanese (kana present) or another language, as the replies already decide. */
export const isChinese = (text: string): boolean =>
  /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)

/**
 * A ticket's state as an ordinary receipt states it. It comes only from native lifecycle facts, never from model text, so a
 * finished task is never reported as deployed: a completed ticket says `本地开发已完成，尚未部署` only when its project is
 * local-only, otherwise that the task is complete; every other state is the shared status text.
 */
export function receiptStatusText(ticket: Ticket, chinese: boolean): string {
  if (ticket.ended?.outcome === 'completed') {
    if (ticket.execution?.project?.localOnly) return chinese ? '本地开发已完成，尚未部署。' : 'Local development is complete and not deployed.'
    return chinese ? '任务已完成。' : 'Task completed.'
  }
  return ticketStatusText(ticket, chinese ? 'zh' : 'en')
}

/**
 * Composes an ordinary receipt body: the heading, a state line from native facts, then the result text (one to three sentences
 * of outcome plus any needed next step). Internal ids, SHAs, paths, logs and token counts stay in the Ticket/Report, not here.
 */
export function composeTicketReceipt(ticket: Ticket, body: string, chinese: boolean): string {
  const heading = ticketHeading(ticket, chinese)
  const status = receiptStatusText(ticket, chinese)
  const label = chinese ? '状态：' : 'Status: '
  return `${heading}\n\n${label}${status}\n\n${body.trim()}`
}

/** A snapshot from existing executor load and Ticket states, computed when a report is delivered. */
export interface TaskSummary { running: number; queued: number; waiting: number; hasWork: boolean }
export function appendTaskSummary(body: string, load: TaskSummary, chinese: boolean): string {
  const footer = chinese
    ? `任务统计：执行中 ${load.running}，排队中 ${load.queued}，等待处理 ${load.waiting}。${load.hasWork ? '当前仍有工作。' : '当前全部任务已结束。'}`
    : `Tasks: ${load.running} running, ${load.queued} queued, ${load.waiting} awaiting handling. ${load.hasWork ? 'Work remains.' : 'All current tasks have ended.'}`
  const compose = (text: string) => `${text.trimEnd()}\n\n${footer}`
  if (wordCount(compose(body)) <= IM_WORDS) return compose(body)
  // Reserve room for factual counts without raising the shared IM limit.
  const chars = Array.from(body)
  let low = 0, high = chars.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (wordCount(compose(chars.slice(0, middle).join('') + '…')) <= IM_WORDS) low = middle
    else high = middle - 1
  }
  return compose(chars.slice(0, low).join('') + '…')
}
