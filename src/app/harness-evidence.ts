import type { HarnessRun, HarnessUsage } from '../core/index.ts';
import { latestAssignment } from '../core/index.ts';
import { GROK_BUILD_MODEL } from './tools/grok.ts';
import { nativeAgyModel } from './tools/agy.ts';
import type { Store } from './store.ts';

/** A failed Harness call's reason, bounded and stripped of credentials before it is stored as evidence. */
export function harnessError(error: unknown): string {
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

/**
 * Records one actual Harness call as evidence under the Ticket's current Assignment, appending to `harnessRuns` so no
 * earlier call is replaced. Only a finished call updates the latest-successful `harnessRun`; failures and unverified
 * writes are retained in the history without erasing an earlier verification.
 */
export function recordHarnessRun(store: Pick<Store,'tickets'|'atomic'>, ticketId: string, name: 'agy'|'codex'|'grok', args: { model?: string; reasoning?: 'low'|'medium'|'high'; mode?: 'read-only'|'write' }, result: unknown, status: 'finished'|'failed'|'unverified', failure?: unknown, originAssignmentId?: string): void {
  const data = result && typeof result === 'object' ? result as Record<string, unknown> : undefined
  const usage = data && typeof data.usage === 'object' && data.usage ? data.usage as HarnessUsage : undefined
  const models = data && Array.isArray(data.models) && data.models.every(item => typeof item === 'string') ? data.models as string[] : undefined
  const rawEvidence = data?.write_evidence as { changedFiles?: unknown; completedEditCalls?: unknown } | undefined
  const changedFiles = optionalCount(rawEvidence?.changedFiles)
  const completedEditCalls = optionalCount(rawEvidence?.completedEditCalls)
  const writeEvidence = changedFiles !== undefined && changedFiles > 0 && completedEditCalls !== undefined
    ? { changedFiles, completedEditCalls } : undefined
  const codexTokens = name === 'codex' ? optionalCount(data?.tokens) : undefined
  const requestedModel = optionalText(data?.requested_model) ?? (name === 'grok' ? GROK_BUILD_MODEL
    : name === 'agy' && (args.model === '4a' || args.model === '3.8f')
      ? nativeAgyModel({ model: args.model, reasoning: args.reasoning ?? 'medium' })
      : name === 'codex' && args.model ? args.model : undefined)
  const fields: Omit<HarnessRun, 'assignmentId'> = {
    harness: name, status, at: new Date().toISOString(),
    ...(name === 'grok' ? { model: GROK_BUILD_MODEL } : args.model ? { model: args.model } : {}),
    ...(requestedModel ? { requestedModel } : {}),
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
    ...(status === 'failed' ? { error: harnessError(failure) }
      : optionalText(data?.error) ? { error: optionalText(data?.error) } : {}),
  }
  store.atomic(() => {
    const latest = store.tickets.get(ticketId)
    if (!latest?.execution) return
    const assignmentId = originAssignmentId ?? latestAssignment(latest)!.id
    if (!latest.assignments.some(item => item.id === assignmentId)) return
    // A stored single `harnessRun` from an earlier version becomes the first history entry instead of being lost.
    const runs = latest.execution.harnessRuns ?? (latest.execution.harnessRun ? [latest.execution.harnessRun] : [])
    latest.execution.harnessRuns = [...runs, { ...fields, assignmentId }]
    if (status === 'finished' && latestAssignment(latest)?.id === assignmentId) latest.execution.harnessRun = { ...fields, assignmentId }
    store.tickets.save(latest)
  })
}
