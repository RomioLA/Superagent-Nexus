/** Reads deployment observations only from the interrupted ticket's own execution directory. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeployNotice } from '../core/index.ts'

export type DeployObservation = { phase: 'none' } | { phase: 'unreadable' }
  | { phase: 'pending'; eventId: string; at?: string } | { phase: 'settled'; notice: DeployNotice }

/** The script's longest bounded step is its 180s health poll: this is a no-progress window, not a total cap. */
export const DEPLOY_STALL_MS = 10 * 60_000

/** Stops watching pending state that has no usable progress timestamp or has stalled. */
export function deployWatchExpired(observation: Extract<DeployObservation, { phase: 'pending' }>, now: number): boolean {
  const at = Date.parse(observation.at ?? '')
  return !Number.isFinite(at) || now - at > DEPLOY_STALL_MS
}

/** Distinguishes in-flight external deployment steps from terminal outcomes, without timestamp filtering. */
export function deployObservation(state: unknown): DeployObservation {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { phase: 'none' }
  const record = state as Record<string, unknown>
  const eventId = typeof record.run === 'string' && record.run.trim()
    || (typeof record.new === 'string' && record.new.trim() ? record.new : '')
  if (!eventId) return { phase: 'none' }
  let result: DeployNotice['result']
  switch (record.step) {
    case 'complete':
      if (record.status !== 'success') return { phase: 'none' }
      result = 'succeeded'
      break
    case 'rolled_back': result = record.status === 'success' ? 'rolled_back' : 'rollback_failed'; break
    case 'aborted': result = 'aborted'; break
    case 'precheck': case 'backup': case 'switched': case 'restarting': case 'healthy_ok': case 'acceptance': case 'already_new': case 'rolling_back':
      return { phase: 'pending', eventId, at: typeof record.at === 'string' ? record.at : undefined }
    default: return { phase: 'none' }
  }
  return { phase: 'settled', notice: { eventId, result, detail: String(record.detail ?? '').slice(0, 160) } }
}

/** Reads the ticket's own state file, distinguishing absence from retryable read or parse failures. */
export function readDeployObservation(directory: string | undefined): DeployObservation {
  if (!directory) return { phase: 'none' }
  try { return deployObservation(JSON.parse(readFileSync(join(directory, 'DEPLOY_STATE.json'), 'utf8'))) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { phase: code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : 'unreadable' }
  }
}
