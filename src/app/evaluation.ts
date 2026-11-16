/**
 * Derive a re-evaluable evidence record from the facts a finished Ticket already stores (P2-4).
 *
 * It reads only existing evidence — HarnessRun records, Assignment reports and the mandate — and never calls a model.
 * Quality, execution reliability, resource consumption, availability and evidence confidence are kept separate so a
 * 429, an expired credential or a CLI start failure is never mistaken for a model that writes code badly. ready Report is a worker claim, NOT human acceptance;
 * metrics a source did not report stay unknown rather than becoming a zero; resources are only summed when every run reported the metric
 * so partial sums are never presented as complete cost; team executions are recorded as a whole rather
 * than splitting one result across members.
 */
import { z } from 'zod'
import { latestReport, type HarnessRun, type HarnessUsage, type Ticket, type QualityReview } from '../core/index.ts'

/** Why a Harness call failed, for availability/reliability only; never used as a quality verdict. */
export type FailureCategory = 'authentication' | 'quota' | 'permission' | 'model' | 'cli' | 'capacity' | 'network' | 'timeout' | 'context' | 'workspace' | 'refusal' | 'unknown'

export interface EvaluationRun {
  harness: HarnessRun['harness']
  status?: HarnessRun['status']
  requestedModel?: string
  servedModel?: string
  models?: string[]
  usage?: HarnessUsage
  error?: string
  at?: string
  assignmentId: string
  provider?: string
  sessionId?: string
  eventSeq?: number
  requestId?: string
}

export interface EvaluationInput {
  task: { title: string; scope: string; strength: string; originTrigger: string; assignment?: string }
  runs: EvaluationRun[]
  dimensions: {
    /** A Worker ready claim only; failures never lower or raise it. */
    quality: { basis: 'ready' | 'none'; note: string }
    reliability: { finished: number; failed: number; unverified: number }
    resources: HarnessUsage & { unknown: string[] }
    availability: { failures: { harness: HarnessRun['harness']; category: FailureCategory }[] }
    evidence: { confidence: 'verified' | 'claimed' | 'none'; unknowns: string[] }
  }
  team: { kind: 'single' | 'unknown'; members: HarnessRun['harness'][]; note: string }
  reports: { assignmentId: string; state: string; at: string }[]
  unknowns: string[]
  at?: string
}

const USAGE_KEYS: readonly (keyof HarnessUsage)[] = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'modelCalls', 'costUSD']

/** Classify a failed call's bounded reason; resource/credential/tool failures are not coding-quality evidence. */
export function classifyHarnessFailure(error?: string): FailureCategory {
  if (!error) return 'unknown'
  if (/unauthori|authentication|not authenticated|not signed in|login required|sign.?in|credential|api.?key|\b401\b/i.test(error)) return 'authentication'
  if (/\b402\b|\b429\b|rate[_\s-]?limit|quota|usage[_\s-]?limit|insufficient|balance|capacity|out of credits|payment required|billing/i.test(error)) return 'quota'
  if (/\b403\b|permission|forbidden|denied|not allowed/i.test(error)) return 'permission'
  if (/unknown model|unsupported model|model not found|couldn't set model|model selection|model .*not .*avail|model .*not supported/i.test(error)) return 'model'
  if (/\b50[0234]\b|service unavailable|overloaded/i.test(error)) return 'capacity'
  if (/timed out|timeout|ETIMEDOUT/i.test(error)) return 'timeout'
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|network|connection.*(?:closed|reset|lost)/i.test(error)) return 'network'
  if (/context.*(?:length|window|exceed)|maximum.*tokens/i.test(error)) return 'context'
  if (/workspace.*conflict|merge conflict|unmerged paths/i.test(error)) return 'workspace'
  if (/model refus|refused to (?:answer|comply)/i.test(error)) return 'refusal'
  if (/ENOENT|not installed|exited|timed out|timeout|sandbox|spawn|CLI/i.test(error)) return 'cli'
  return 'unknown'
}

const usageLabel = (key: keyof HarnessUsage): string => key === 'costUSD' ? 'cost_usd' : key

/** Build the evaluation input for one Ticket from its stored evidence only. */
export function evaluationInput(ticket: Ticket): EvaluationInput {
  const runs: EvaluationRun[] = (ticket.execution?.harnessRuns
    ?? (ticket.execution?.harnessRun ? [ticket.execution.harnessRun] : []))
    .map(run => ({
      harness: run.harness, assignmentId: run.assignmentId,
      ...(run.provider ? { provider: run.provider } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.eventSeq !== undefined ? { eventSeq: run.eventSeq } : {}),
      ...(run.requestId ? { requestId: run.requestId } : {}),
      ...(run.status ? { status: run.status } : {}),
      ...(run.requestedModel ? { requestedModel: run.requestedModel } : {}),
      ...(run.servedModel ? { servedModel: run.servedModel } : {}),
      ...(run.models ? { models: run.models } : {}),
      ...(run.usage ? { usage: run.usage } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(run.at ? { at: run.at } : {}),
    }))

  const reports = ticket.assignments.flatMap(assignment =>
    assignment.report ? [{ assignmentId: assignment.id, state: assignment.report.state, at: assignment.report.at }] : [])

  // Aggregate usage subtotals only when every HarnessRun reported every metric; otherwise mark the metric unknown.
  // This prevents presenting partial sums as complete cost when any run omitted the metric.
  const fullSubtotals: Partial<Record<keyof HarnessUsage, number>> = {}
  const resourcesUnknown: string[] = []
  for (const key of USAGE_KEYS) {
    const providedByAll = runs.length > 0 && runs.every(run => {
      const value = run.usage?.[key]
      return typeof value === 'number' && Number.isFinite(value)
    })
    if (providedByAll) {
      const sum = runs.reduce((acc, run) => acc + (run.usage?.[key] ?? 0), 0)
      fullSubtotals[key] = sum
    } else {
      resourcesUnknown.push(usageLabel(key))
    }
  }
  const resources: HarnessUsage & { unknown: string[] } = { ...fullSubtotals, unknown: resourcesUnknown }
  const unknowns = new Set<string>()
  // Neither worker reports nor successful model settlements verify artifact quality. No structured result/acceptance
  // source is currently recorded on a Ticket; keep that gap visible even after its execution ends.
  unknowns.add('machine_verified_test_results')
  unknowns.add('user_acceptance')
  for (const key of USAGE_KEYS) if (!(key in fullSubtotals)) unknowns.add(usageLabel(key))

  const failures = runs.filter(run => run.status === 'failed')
    .map(run => ({ harness: run.harness, category: classifyHarnessFailure(run.error) }))
  for (const run of runs) if (!run.servedModel) unknowns.add(`served_model:${run.harness}`)

  const latestAssignmentId = ticket.assignments.at(-1)?.id
  // Verified means an observed completion, not a verified model identity; missing served models remain in unknowns.
  const verified = runs.some(run => run.status === 'finished' && run.assignmentId === latestAssignmentId)
  const confidence = verified ? 'verified' : runs.length ? 'claimed' : 'none'
  const latest = latestReport(ticket)
  const members = [...new Set(runs.map(run => run.harness))]
  const collaboration = members.length > 1

  return {
    task: { title: ticket.title, scope: ticket.mandate.scope, strength: ticket.mandate.strength,
      originTrigger: ticket.origin.triggerId, ...(ticket.execution?.assignment ? { assignment: ticket.execution.assignment } : {}) },
    runs,
    dimensions: {
      quality: { basis: latest?.state === 'ready' ? 'ready' : 'none',
        note: 'A Worker ready report is an unreviewed claim, not human acceptance; failures belong to reliability or availability. ready Report is a worker claim, NOT human acceptance.' },
      reliability: {
        finished: runs.filter(run => run.status === 'finished').length,
        failed: failures.length,
        unverified: runs.filter(run => run.status === 'unverified').length,
      },
      resources,
      availability: { failures },
      evidence: { confidence, unknowns: [...unknowns] },
    },
    team: { kind: members.length === 1 ? 'single' : 'unknown', members,
      note: collaboration
        ? 'Several Harness calls were observed; sequential fallback does not establish a collaborating team or member contributions.'
        : members.length ? 'One Harness observed; no unobserved collaboration or contribution is inferred.' : 'No executing Harness was observed.' },
    reports,
    unknowns: [...unknowns],
    ...(runs.map(run => run.at).filter((at): at is string => !!at).sort().at(-1) ? { at: runs.map(run => run.at).filter((at): at is string => !!at).sort().at(-1) } : {}),
  }
}

/** Versioned human/agent review of existing facts, retained in the Ticket rather than a second scoring database. */
export const QualityReviewSchema = z.object({
  id: z.string().min(1), harness: z.enum(['dsh', 'agy', 'codex', 'grok']), model: z.string().min(1),
  taskType: z.string().min(1), difficulty: z.string().min(1), conditions: z.string().min(1),
  ruleVersion: z.string().min(1), artifact: z.string().min(1), evaluator: z.string().min(1),
  assignmentId: z.string().min(1), evidenceRefs: z.array(z.string().min(1)).min(1),
  verdict: z.enum(['meets', 'does-not-meet', 'unknown']), origin: z.enum(['live', 'fixture']),
  calibration: z.string().min(1).optional(), sufficiency: z.string().min(1).optional(),
  supersedes: z.string().min(1).optional(), at: z.iso.datetime(),
}).strict()
export type { QualityReview } from '../core/index.ts'
export interface QualityContext { taskType: string; difficulty: string; conditions: string; ruleVersion: string }
export interface QualityStanding {
  harness: QualityReview['harness']; model: string
  status: 'provisional' | 'evidence-backed' | 'disputed'
  verdict?: 'meets' | 'does-not-meet'
  reviews: QualityReview[]; reasons: string[]
}
/** Same-context reviews only: no numeric score, cross-rule averaging or easy-task credit for hard tasks. */
export function summarizeQuality(reviews: readonly QualityReview[], context: QualityContext, origin: 'live' | 'fixture' = 'live'): QualityStanding[] {
  const matching = reviews.filter(review => review.origin === origin && review.taskType === context.taskType
    && review.difficulty === context.difficulty && review.conditions === context.conditions && review.ruleVersion === context.ruleVersion)
  const active = matching.filter(review => !matching.some(newer => newer.supersedes === review.id && newer.evaluator === review.evaluator
    && newer.artifact === review.artifact && newer.harness === review.harness && newer.model === review.model && newer.at > review.at))
  const groups = new Map<string, QualityReview[]>()
  for (const review of active) { const key = JSON.stringify([review.harness, review.model]); groups.set(key, [...groups.get(key) ?? [], review]) }
  return [...groups.values()].map(group => {
    const first = group[0]!
    const verdicts = new Set(group.map(review => review.verdict).filter(verdict => verdict !== 'unknown'))
    const disputed = verdicts.size > 1
    // Sufficiency and calibration are explicit, attributable review decisions, never an invented sample threshold.
    const supported = group.length > 0 && group.every(review => review.calibration && review.sufficiency && review.evidenceRefs.length && review.verdict !== 'unknown')
    const status = disputed ? 'disputed' as const : supported ? 'evidence-backed' as const : 'provisional' as const
    return { harness: first.harness, model: first.model, status, reviews: group,
      ...(status === 'evidence-backed' ? { verdict: first.verdict as 'meets' | 'does-not-meet' } : {}),
      reasons: [disputed ? 'Reviewers or comparable outcomes disagree; no averaging or definitive ranking.'
        : supported ? 'Comparable evidence has explicit calibration and sufficiency decisions.' : 'Evidence, calibration or sufficiency is incomplete; provisional only.'] }
  })
}
/** Verify live identity and evidence against the existing Ticket before a review can influence live routing. */
export function validateQualityReview(ticket: Ticket, review: QualityReview): QualityReview {
  QualityReviewSchema.parse(review)
  if (review.origin !== 'live') throw new Error('Fixture reviews cannot be stored as production evidence')
  const assignment = ticket.assignments.find(item => item.id === review.assignmentId)
  const runs = ticket.execution?.harnessRuns ?? (ticket.execution?.harnessRun ? [ticket.execution.harnessRun] : [])
  const run = runs.find(item => item.assignmentId === review.assignmentId && item.harness === review.harness
    && item.status === 'finished' && (item.servedModel === review.model || (item.models?.length === 1 && item.models[0] === review.model)))
  if (!assignment?.report || !run || !review.evidenceRefs.includes(`ticket/${ticket.id}`))
    throw new Error('A live review needs an existing report, finished exact Harness/served-model evidence and the Ticket reference')
  return review
}
