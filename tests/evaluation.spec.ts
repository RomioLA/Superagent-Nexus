import { describe, expect, it } from 'vitest'
import { classifyHarnessFailure, evaluationInput, summarizeQuality, validateQualityReview, type QualityReview } from '../src/app/evaluation.ts'
import type { Ticket } from '../src/core/index.ts'

/** A finished Ticket whose stored evidence mixes a working call, a failed call and a missing metric. */
const ticket = {
  id: 'ticket-1', title: 'Implement the change', decisionId: 'd1', channels: [], inputs: [], undelivered: [],
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed', sender: 'Alice' }, actor: { source: 'feishu', id: 'alice' }, scope: 'small change' },
  assignments: [{
    id: 'a1', state: 'ended', createdAt: '2026-09-09T00:00:00Z', startedAt: '2026-09-09T00:00:00Z',
    report: { state: 'ready', summary: 'Done', at: '2026-09-09T01:00:00Z' },
  }],
  createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T01:00:00Z',
  origin: { triggerId: 'request-1', triggerIds: ['request-1'] },
  execution: {
    name: 'ticket-1', directory: '/worktrees/ticket-1', assignment: 'Implement the change.',
    harnessRuns: [
      { harness: 'codex', status: 'finished', at: '2026-09-09T00:30:00Z', assignmentId: 'a1',
        model: 'gpt-6-luna', requestedModel: 'gpt-6-luna', usage: { totalTokens: 1200, modelCalls: 1 } },
      { harness: 'grok', status: 'failed', at: '2026-09-09T00:40:00Z', assignmentId: 'a1',
        model: 'grok-4.7-build-fast', requestedModel: 'grok-4.7-build-fast', error: 'failed: Grok authentication failed' },
    ],
  },
  follows: [],
} as unknown as Ticket

describe('evaluation input derives re-evaluable facts from stored evidence only', () => {
  it('keeps quality separate from a credential/availability failure', () => {
    const input = evaluationInput(ticket)
    // Quality comes from the human-accepted report, never from the failed call.
    expect(input.dimensions.quality.basis).toBe('ready')
    expect(input.dimensions.reliability).toEqual({ finished: 1, failed: 1, unverified: 0 })
    expect(input.dimensions.availability.failures).toEqual([{ harness: 'grok', category: 'authentication' }])
  })

  it('records a team execution as a whole and never invents a missing metric as zero', () => {
    const input = evaluationInput(ticket)
    expect(input.team).toMatchObject({ kind: 'unknown', members: ['codex', 'grok'] })
    // Cost and cache were not reported by any call, so they stay unknown rather than becoming 0.
    expect(input.dimensions.resources.totalTokens).toBeUndefined()
    expect(input.dimensions.resources.costUSD).toBeUndefined()
    expect(input.unknowns).toContain('cost_usd')
    expect(input.unknowns).toContain('cacheReadTokens')
    // The finished codex call verified the latest assignment; the grok call reported no served model.
    expect(input.dimensions.evidence.confidence).toBe('verified')
    expect(input.unknowns).toContain('served_model:grok')
    expect(input.dimensions.evidence.unknowns).toEqual(input.unknowns)
  })

  it('treats a single Harness as one executor, not a team with split credit', () => {
    const single = { ...ticket, execution: { ...ticket.execution!, harnessRuns: [ticket.execution!.harnessRuns![0]!] } } as Ticket
    const input = evaluationInput(single)
    expect(input.team.kind).toBe('single')
    expect(input.team.members).toEqual(['codex'])
  })

  it('classifies failures by resource/credential cause, not as coding quality', () => {
    expect(classifyHarnessFailure('429 Too Many Requests')).toBe('quota')
    expect(classifyHarnessFailure('401 Unauthorized token expired')).toBe('authentication')
    expect(classifyHarnessFailure('permission denied: tool not allowed')).toBe('permission')
    expect(classifyHarnessFailure('codex exited 1: unknown model')).toBe('model')
    expect(classifyHarnessFailure("Codex exited 1; The 'p2-acceptance-invalid-20261115' model is not supported when using Codex with a ChatGPT account.")).toBe('model')
    expect(classifyHarnessFailure('spawn grok ENOENT')).toBe('cli')
  })
})

const context = { taskType: 'development', difficulty: 'complex', conditions: 'same project and read/write constraints', ruleVersion: 'ac-v1' }
const review = (over: Partial<QualityReview> = {}): QualityReview => ({ id: 'r1', harness: 'codex', model: 'gpt-6-luna', ...context,
  artifact: 'patch-1', evaluator: 'reviewer-A', assignmentId: 'a1', evidenceRefs: ['ticket/ticket-1', 'tests/report-1'],
  verdict: 'meets', origin: 'fixture', calibration: 'anchored to AC report', sufficiency: 'reviewed comparable evidence is sufficient', at: '2026-11-15T00:00:00Z', ...over })
it('keeps evaluator disagreement and rule versions visible without averaging or transferring easy-task credit', () => {
  const reviews = [review(), review({ id: 'r2', evaluator: 'reviewer-B', verdict: 'does-not-meet' }),
    review({ id: 'old', ruleVersion: 'ac-v0' }), review({ id: 'easy', difficulty: 'simple' })]
  const summary = summarizeQuality(reviews, context, 'fixture')
  expect(summary[0]).toMatchObject({ status: 'disputed' })
  expect(summary[0]?.verdict).toBeUndefined()
  expect(summary[0]?.reviews.map(row => row.id)).toEqual(['r1', 'r2'])
  expect(summarizeQuality(reviews, { ...context, difficulty: 'new' }, 'fixture')).toEqual([])
  expect(summarizeQuality(reviews, context)).toEqual([])
})
it('retains a superseded review for audit but only compares its evaluator’s latest review of the same artifact', () => {
  const old = review({ verdict: 'does-not-meet' })
  const newer = review({ id: 'r2', supersedes: 'r1', at: '2026-11-15T01:00:00Z' })
  expect(summarizeQuality([old, newer], context, 'fixture')[0]).toMatchObject({ status: 'evidence-backed', verdict: 'meets' })
  expect(summarizeQuality([old, { ...newer, evaluator: 'other' }], context, 'fixture')[0]?.status).toBe('disputed')
  expect(old.verdict).toBe('does-not-meet')
})
it('requires calibration and an explicit sufficiency decision, keeping missing or resource-only facts provisional', () => {
  expect(summarizeQuality([review({ calibration: undefined })], context, 'fixture')[0]?.status).toBe('provisional')
  expect(summarizeQuality([review({ sufficiency: undefined })], context, 'fixture')[0]?.status).toBe('provisional')
  const none = evaluationInput({ ...ticket, execution: { ...ticket.execution!, harnessRuns: [] } })
  expect(none.dimensions.resources.costUSD).toBeUndefined()
  expect(none.unknowns).toContain('cost_usd')
  expect(evaluationInput(ticket).team.kind).toBe('unknown')
  expect(evaluationInput(ticket).dimensions.quality.note).toContain('not human acceptance')
})
it('rejects fixture, failed-call and requested-only identity as live quality evidence', () => {
  expect(() => validateQualityReview(ticket, review())).toThrow('Fixture')
  expect(() => validateQualityReview(ticket, review({ origin: 'live' }))).toThrow('served-model')
  const finished = { ...ticket, execution: { ...ticket.execution!, harnessRuns: ticket.execution!.harnessRuns!.map(run => ({ ...run, servedModel: run.requestedModel })) } }
  expect(validateQualityReview(finished, review({ origin: 'live' })).id).toBe('r1')
  expect(() => validateQualityReview(finished, review({ origin: 'live', harness: 'grok', model: 'grok-4.7-build-fast' }))).toThrow('finished')
})
