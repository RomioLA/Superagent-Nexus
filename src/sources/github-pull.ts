/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { githubPage, githubThreadId, parseGithubThreadId, SOURCE, UserSchema } from './github-trigger.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number; repository?: string }
/** True when `repository` is the Source's primary repository or one the operator listed as authorized; never a default guess. */
export const repositoryAuthorized = (repository: string, primary: string, extra: readonly string[] | undefined): boolean =>
  sameName(repository, primary) || (extra ?? []).some(item => sameName(item, repository))
/** Reads one pull request from its own repository; refuses a repository the GitHub Source has not authorized for tracking. */
export const readPull = async (ctx: SourceContext, repository: string, number: number, signal?: AbortSignal): Promise<Pull> => {
  const config = ctx.config<{ repositories?: string[] }>('github')
  if (!repositoryAuthorized(repository, ctx.deployment.repository, config?.repositories)) {
    throw new Error(`The GitHub Source does not authorize tracking ${repository}`)
  }
  return { ...await ctx.commands.forRepository(repository).withSignal(signal).api(PullSchema, `pulls/${number}`), number, repository }
}
/** A pull request a Ticket follows, by repository (undefined for the primary) and number. */
export interface TicketPull { repository?: string; number: number }
const followPull = (thread: string): TicketPull | undefined => {
  if (!thread.startsWith(`${SOURCE}:`)) return undefined
  const parsed = parseGithubThreadId(thread.slice(SOURCE.length + 1))
  return Number.isFinite(parsed.number) ? { number: parsed.number, ...parsed.repository ? { repository: parsed.repository } : {} } : undefined
}
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): TicketPull[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => followPull(item.thread) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => pullsOf(ticket, true).at(-1)?.number ?? pullsOf(ticket).at(-1)?.number
/** True when the PR was opened by the agent account from a branch in `repository` (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  deployment: Pick<Deployment, 'github' | 'repository'>, repository = deployment.repository): boolean =>
  sameName(pr.user.login, deployment.github.login) && sameName(pr.head?.repo?.full_name ?? '', repository)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }
/** True when a follow names the same pull request in the same repository (defaulting a bare follow to the primary). */
const samePull = (ref: TicketPull, pr: Pull, primary: string): boolean =>
  ref.number === pr.number && sameName(ref.repository ?? primary, pr.repository ?? primary)

/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const repository = pr.repository ?? ctx.deployment.repository
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const originRepository = typeof source?.meta.repository === 'string' ? source.meta.repository : ctx.deployment.repository
  const started = source?.source === SOURCE && source.meta.isPr === true && source.meta.number === pr.number && sameName(originRepository, repository)
  const opened = agentPull(pr, ctx.deployment, repository) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const { login } = ctx.deployment.github
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).some(ref => samePull(ref, pr, ctx.deployment.repository)))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const threadId = githubThreadId(repository, ctx.deployment.repository, pr.number)
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${threadId}`)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, repository, threadId, opened)
  return undefined
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const repository = pr.repository ?? ctx.deployment.repository
  const threadId = githubThreadId(repository, ctx.deployment.repository, pr.number)
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended) closePull(ctx, pr, repository, threadId)
  else {
    const candidates = agentPull(pr, ctx.deployment, repository) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:${threadId}` && item.closed)
    const only = (ticket ? pullsOf(ticket, true) : []).every(ref => samePull(ref, pr, ctx.deployment.repository))
    if (ticket && (reopened || only)) claimPull(ctx, ticket.id, pr)
  }
  ctx.threads.describe(`github:${threadId}`, { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, repository: string, threadId: string, own: boolean): void {
  const secondary = sameName(repository, ctx.deployment.repository) ? undefined : repository
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: threadId }, own)
    ctx.threads.patch(`github:${threadId}`, { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login, ...(secondary ? { repository: secondary } : {}) })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull, repository: string, threadId: string): void {
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).some(ref => samePull(ref, pr, ctx.deployment.repository)))) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: threadId }, pr.merged ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && followPull(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const ref = followPull(follow.thread)!
  const number = ref.number
  const url = githubPage(ref.repository ?? repository, number, true)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  // GitHub timelines and linked issues already show the merge or closure, so GitHub channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
