import type { HarnessSpec, HarnessUsage, Ticket } from '../core/index.ts'
import { runTicketCodex } from '../app/tools/codex.ts'
import { runTicketGrok } from '../app/tools/grok.ts'
import { runTicketAgy } from '../app/tools/agy.ts'

export interface DirectRunResult {
  status: 'finished' | 'failed' | 'unverified' | 'limit_reached'
  summary: string
  writeEvidence?: { changedFiles: number; completedEditCalls: number }
  usage?: HarnessUsage
  models?: string[]
  servedModel?: string
  sessionId?: string
  cliVersion?: string
  error?: string
}

export type DirectRunner = (input: {
  harness: HarnessSpec
  directory: string
  ticketId: string
  task: string
  mode: 'read-only' | 'write'
  signal: AbortSignal
  reasoning?: 'low' | 'medium' | 'high'
}) => Promise<DirectRunResult>

export async function defaultDirectRunner(input: {
  harness: HarnessSpec
  directory: string
  ticketId: string
  task: string
  mode: 'read-only' | 'write'
  signal: AbortSignal
  reasoning?: 'low' | 'medium' | 'high'
}): Promise<DirectRunResult> {
  const { harness, directory, ticketId, task, mode, signal } = input
  if (harness.harness === 'codex') {
    if (!harness.model) throw new Error('Codex requires an explicit authorized model')
    const result = await runTicketCodex(directory, ticketId, task, { mode, model: harness.model, ...(input.reasoning ? { reasoning: input.reasoning } : {}) }, signal)
    return { status: 'finished', summary: result.summary,
      ...(result.tokens !== undefined ? { usage: { totalTokens: result.tokens } } : {}),
      models: result.requested_model ? [result.requested_model] : [], ...(result.requested_model ? { servedModel: result.requested_model } : {}) }
  }
  if (harness.harness === 'grok') {
    const result = await runTicketGrok(directory, ticketId, task, { mode }, signal)
    const status: DirectRunResult['status'] = result.status === 'limit_reached' ? 'limit_reached'
      : mode === 'write' && !result.write_evidence?.changedFiles ? 'unverified' : 'finished'
    return { status, summary: result.summary, ...(result.write_evidence ? { writeEvidence: result.write_evidence } : {}),
      ...(result.usage ? { usage: result.usage } : {}), ...(result.models ? { models: result.models } : {}),
      ...(result.models && result.models.length === 1 ? { servedModel: result.models[0]! } : {}),
      ...(result.session_id ? { sessionId: result.session_id } : {}), ...(result.cli_version ? { cliVersion: result.cli_version } : {}) }
  }
  const model = harness.model === '4a' ? '4a' : '3.8f'
  const result = await runTicketAgy(directory, ticketId, { task, mode, model, reasoning: 'medium' }, signal)
  return { status: 'finished', summary: result.summary, ...(result.usage ? { usage: result.usage } : {}) }
}

export async function runDirectWorker(ticket: Ticket, directory: string, task: string, harness: HarnessSpec,
  signal: AbortSignal, runner: DirectRunner = defaultDirectRunner): Promise<DirectRunResult> {
  return runner({ harness, directory, ticketId: ticket.id, task, mode: harness.mode ?? 'write', signal })
}
