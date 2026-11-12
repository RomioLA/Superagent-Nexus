/** Ordinary user-facing receipts: the ticket's number and title, its true state from native facts, and the result body. */
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
