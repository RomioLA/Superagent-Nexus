/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { latestAssignment, liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'
import { ticketCodexTool } from './codex.ts'
import { ticketAgyTool } from './agy.ts'
import { GROK_BUILD_MODEL, ticketGrokTool } from './grok.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  const delegate = (name: 'agy' | 'codex' | 'grok', selected: Tool): Tool => ({ ...selected, execute: async (raw, signal) => {
    const current = host.store.tickets.get(ticketId)
    if (!current || !liveTicket(current)) throw new Error('Ticket ended')
    const required = current.execution?.harness
    if (required && required.harness !== name && required.allowFallback !== true) throw new Error('This Ticket requires ' + required.harness)
    const args = raw as { model?: string }
    if (name === 'agy' && args.model === '4a' && (required?.model !== '4a' || required.forbid4a))
      throw new Error('AGY 4a requires explicit authorization; no automatic upgrade from 3.8f')
    if (name === 'agy' && required?.harness === 'agy' && args.model !== (required.model ?? '3.8f'))
      throw new Error('Use the authorized AGY model ' + (required.model ?? '3.8f'))
    // A later failed Grok run cannot borrow an earlier successful run's ready authorization.
    if (name === 'grok' && current.execution?.harnessRun) host.store.atomic(() => {
      delete current.execution!.harnessRun
      host.store.tickets.save(current)
    })
    const result = await selected.execute(raw, signal)
    const grok = name === 'grok' && result && typeof result === 'object'
      ? result as { cli_version?: unknown; models?: unknown; session_id?: unknown; request_id?: unknown; usage?: unknown }
      : undefined
    host.store.atomic(() => {
      const latest = host.store.tickets.get(ticketId)
      if (latest && liveTicket(latest) && latest.execution) {
        latest.execution.harnessRun = { assignmentId: latestAssignment(current)!.id, harness: name,
          ...(name === 'grok' ? { model: GROK_BUILD_MODEL } : args.model ? { model: args.model } : {}),
          ...(typeof grok?.cli_version === 'string' ? { version: grok.cli_version } : {}),
          ...(Array.isArray(grok?.models) && grok.models.every(item => typeof item === 'string') ? { models: grok.models } : {}),
          ...(typeof grok?.session_id === 'string' ? { sessionId: grok.session_id } : {}),
          ...(typeof grok?.request_id === 'string' ? { requestId: grok.request_id } : {}),
          ...(grok?.usage && typeof grok.usage === 'object' ? { usage: grok.usage as {
            inputTokens?: number; outputTokens?: number; totalTokens?: number; modelCalls?: number; costUSD?: number
          } } : {}) }
        host.store.tickets.save(latest)
      }
    })
    return result
  } })
  return [
    delegate('codex', ticketCodexTool(ticket)),
    delegate('agy', ticketAgyTool(ticket)),
    delegate('grok', ticketGrokTool(ticket, { assignmentId: () => {
      const current = host.store.tickets.get(ticketId)
      return current && latestAssignment(current)?.id
    } })),
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${host.github.deployment.github.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        // The native GitHub watcher is bound to its configured primary repository.
        // A PR number from a different project may refer to an unrelated PR in that repository.
        const originRepo = current.execution?.project?.repository ?? host.github.triggers.get(current.origin.triggerId)?.meta.projectRepository
        if (args.pr_number != null && current.execution?.project?.localOnly) throw new Error('Local-only Ticket cannot claim a PR')
        const required = current.execution?.harness
        const run = current.execution?.harnessRun
        if (args.state === 'ready' && required && required.harness !== 'dsh'
          && (!run || run.assignmentId !== latestAssignment(current)?.id || (run.harness !== required.harness && required.allowFallback !== true)))
          throw new Error('No successful execution of the required Harness for this assignment; report blocked or failed')
        if (args.pr_number != null && typeof originRepo === 'string'
          && originRepo.toLowerCase() !== host.github.deployment.repository.toLowerCase())
          throw new Error('This ticket targets another repository: omit pr_number and include the full PR URL in summary')
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
  ]
}
