/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { latestAssignment, liveTicket, type EngineForExecutor, type HarnessRun, type HarnessUsage, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull, repositoryAuthorized } from '../../sources/github-pull.ts'
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

/** A failed Harness call's reason, bounded and stripped of credentials before it is stored as evidence. */
function harnessError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const safe = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:xai-|sk-)[A-Za-z0-9._-]{12,}\b/gi, '[redacted credential]')
    .replace(/[\r\n\t ]+/g, ' ').trim()
  return safe.slice(0, 400) || 'Harness call failed'
}

const optionalText = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const optionalNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const optionalCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  /**
   * Records one actual Harness call as evidence under the Ticket's current Assignment, appending to `harnessRuns` so no
   * earlier call is replaced. Only a finished call updates the latest-successful `harnessRun`; failures and unverified
   * writes are retained in the history without erasing an earlier verification.
   */
  const recordHarnessRun = (name: 'agy' | 'codex' | 'grok', args: { model?: string; mode?: 'read-only' | 'write' },
    result: unknown, status: 'finished' | 'failed' | 'unverified', failure?: unknown) => {
    const data = result && typeof result === 'object' ? result as Record<string, unknown> : undefined
    const usage = data && typeof data.usage === 'object' && data.usage ? data.usage as HarnessUsage : undefined
    const models = data && Array.isArray(data.models) && data.models.every(item => typeof item === 'string') ? data.models as string[] : undefined
    const rawEvidence = data?.write_evidence as { changedFiles?: unknown; completedEditCalls?: unknown } | undefined
    const changedFiles = optionalCount(rawEvidence?.changedFiles)
    const completedEditCalls = optionalCount(rawEvidence?.completedEditCalls)
    const writeEvidence = changedFiles !== undefined && changedFiles > 0 && completedEditCalls !== undefined
      ? { changedFiles, completedEditCalls } : undefined
    const codexTokens = name === 'codex' ? optionalCount(data?.tokens) : undefined
    const fields: Omit<HarnessRun, 'assignmentId'> = {
      harness: name, status, at: new Date().toISOString(),
      ...(name === 'grok' ? { model: GROK_BUILD_MODEL } : args.model ? { model: args.model } : {}),
      ...(name === 'grok' ? { mode: args.mode ?? 'write' } : args.mode ? { mode: args.mode } : {}),
      ...(writeEvidence ? { writeEvidence } : {}),
      ...(optionalText(data?.cli_version) ? { version: optionalText(data?.cli_version) } : {}),
      ...(models ? { models } : {}),
      ...(models && models.length === 1 ? { servedModel: models[0]! } : {}),
      ...(optionalText(data?.session_id) ? { sessionId: optionalText(data?.session_id) } : {}),
      ...(optionalText(data?.request_id) ? { requestId: optionalText(data?.request_id) } : {}),
      ...(usage ? { usage } : codexTokens ? { usage: { totalTokens: codexTokens } } : {}),
      ...(optionalNumber(data?.duration_seconds) !== undefined ? { durationSeconds: optionalNumber(data?.duration_seconds) } : {}),
      ...(optionalCount(data?.turns) !== undefined ? { turns: optionalCount(data?.turns) } : {}),
      ...(status === 'failed' ? { error: harnessError(failure) } : {}),
    }
    host.store.atomic(() => {
      const latest = host.store.tickets.get(ticketId)
      if (!latest || !liveTicket(latest) || !latest.execution) return
      const assignmentId = latestAssignment(latest)!.id
      // A stored single `harnessRun` from an earlier version becomes the first history entry instead of being lost.
      const runs = latest.execution.harnessRuns ?? (latest.execution.harnessRun ? [latest.execution.harnessRun] : [])
      latest.execution.harnessRuns = [...runs, { ...fields, assignmentId }]
      if (status === 'finished') latest.execution.harnessRun = { ...fields, assignmentId }
      host.store.tickets.save(latest)
    })
  }
  const delegate = (name: 'agy' | 'codex' | 'grok', selected: Tool): Tool => ({ ...selected, execute: async (raw, signal) => {
    const current = host.store.tickets.get(ticketId)
    if (!current || !liveTicket(current)) throw new Error('Ticket ended')
    const required = current.execution?.harness
    if (required && required.harness !== name && required.allowFallback !== true) throw new Error('This Ticket requires ' + required.harness)
    const args = raw as { model?: string; mode?: 'read-only' | 'write' }
    if (name === 'agy' && args.model === '4a' && (required?.model !== '4a' || required.forbid4a))
      throw new Error('AGY 4a requires explicit authorization; no automatic upgrade from 3.8f')
    if (name === 'agy' && required?.harness === 'agy' && args.model !== (required.model ?? '3.8f'))
      throw new Error('Use the authorized AGY model ' + (required.model ?? '3.8f'))
    let result: unknown
    try {
      result = await selected.execute(raw, signal)
    } catch (error) {
      recordHarnessRun(name, args, undefined, 'failed', error)
      throw error
    }
    // An unverified write is not a successful Harness execution; retain the attempt but keep any earlier native receipt.
    const status = result && typeof result === 'object' && (result as { status?: unknown }).status === 'unverified' ? 'unverified' : 'finished'
    recordHarnessRun(name, args, result, status)
    return result
  } })
  return [
    delegate('codex', ticketCodexTool(ticket)),
    delegate('agy', ticketAgyTool(ticket)),
    delegate('grok', ticketGrokTool(ticket)),
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
        // A project Ticket's PR lives in that project's repository, which the GitHub Source must authorize for tracking.
        const projectRepository = current.execution?.project?.repository ?? host.github.triggers.get(current.origin.triggerId)?.meta.projectRepository
        const repository = typeof projectRepository === 'string' && projectRepository ? projectRepository : host.github.deployment.repository
        if (args.pr_number != null && current.execution?.project?.localOnly) throw new Error('Local-only Ticket cannot claim a PR')
        const required = current.execution?.harness
        const run = current.execution?.harnessRun
        if (args.state === 'ready' && required && required.harness !== 'dsh'
          && (!run || run.assignmentId !== latestAssignment(current)?.id || (run.harness !== required.harness && required.allowFallback !== true)))
          throw new Error('No successful execution of the required Harness for this assignment; report blocked or failed')
        const sourceConfig = host.github.config<{ repositories?: string[] }>('github')
        if (args.pr_number != null && !repositoryAuthorized(repository, host.github.deployment.repository, sourceConfig?.repositories))
          throw new Error(`The GitHub Source does not authorize tracking ${repository}: add it to its repositories, or omit pr_number and include the full PR URL in summary`)
        const pull = args.pr_number != null ? await readPull(host.github, repository, args.pr_number, signal) : undefined
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
