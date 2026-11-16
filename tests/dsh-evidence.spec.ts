import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, ProviderRequestId, type FinishReason } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { evaluationInput, validateQualityReview, type QualityReview } from '../src/app/evaluation.ts'
import type { HarnessRun, Ticket } from '../src/core/index.ts'
import { DshExecutor, type ExecutorHost } from '../src/executor/dsh.ts'

let ctx: Context, session: Session, executor: DshExecutor, ticket: Ticket
let agents: Map<string, { session: Session }>
const requested = 'auto/worker-model', served = 'provider-model-20261115'
const response = (over: Record<string, unknown> = {}) => Object.fromEntries(Object.entries({ kind: 'pi-ai', version: 2,
  provider: 'magpie', model: requested, responseModel: served, api: 'openai-completions', stopReason: 'stop', ...over })
  .filter(([, value]) => value !== undefined))
const runs = () => ticket.execution!.harnessRuns ?? []
const review = (): QualityReview => ({ id: 'review', harness: 'dsh', model: served, taskType: 'development', difficulty: 'simple',
  conditions: 'same workspace', ruleVersion: 'v1', artifact: 'patch', evaluator: 'person', assignmentId: 'a1',
  evidenceRefs: ['ticket/t1'], verdict: 'meets', origin: 'live', at: new Date().toISOString() })
function publish<T extends SessionEvent>(event: T, target = session): T {
  ctx.emit('session/event', target, event)
  return event
}
const start = (turn = 1, step = 1) => publish(session.append('step/start', { turn, step }))
function settle(options: { replay?: unknown; finish?: FinishReason; interrupted?: true; turn?: number; step?: number; usage?: true } = {}) {
  const message = createAssistantMessage({ content: [{ type: 'text', text: 'result' }], source: { provider: 'magpie', model: requested,
    ...(options.replay !== undefined ? { replayState: options.replay } : {}) } })
  return publish(session.append('assistant/message', { turn: options.turn ?? 1, step: options.step ?? 1, message,
    stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'finish', reason: options.finish ?? { kind: 'stop' } } }],
    ...(options.interrupted ? { interrupted: true } : {}),
    ...(options.usage ? { usage: { inputTokens: 12, outputTokens: 3, totalTokens: 25, cacheReadTokens: 10 } } : {}),
  }, { surfaceOp: 'append' }))
}
beforeEach(() => {
  ctx = new Context()
  session = Session.create(SessionId('worker-t1'))
  agents = new Map([[session.id, { session }]])
  ctx.reflect.provide('agents', agents)
  ticket = { id: 't1', title: 'change', decisionId: 'd1', channels: [], inputs: [], undelivered: [],
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed', sender: 'Alice' },
      actor: { source: 'feishu', id: 'alice' }, scope: 'change' },
    assignments: [{ id: 'a1', state: 'running', createdAt: new Date().toISOString() }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), origin: { triggerId: 'request', triggerIds: ['request'] },
    execution: { name: 'change', directory: '/work/change', assignment: 'change' } }
  const host = { context: ctx, closing: () => false,
    store: { tickets: { get: (id: string) => id === ticket.id ? structuredClone(ticket) : undefined,
      save: (value: Ticket) => { ticket = structuredClone(value) } }, atomic: (work: () => void) => work() },
    effects: { handle: vi.fn() }, health: { get: vi.fn(), set: vi.fn() },
  } as unknown as ExecutorHost
  executor = new DshExecutor(host)
  executor.install()
})
afterEach(() => { executor.dispose(); vi.restoreAllMocks() })

it('records response-reported identity and usage against the exact Session event and original Assignment', () => {
  start()
  const event = settle({ replay: { response: response(), blocks: [{ type: 'text' }] }, usage: true })
  expect(runs()).toEqual([{ harness: 'dsh', assignmentId: 'a1', provider: 'magpie', requestedModel: requested, servedModel: served,
    sessionId: session.id, eventSeq: event.seq, at: new Date(event.time).toISOString(), status: 'finished',
    usage: { inputTokens: 12, outputTokens: 3, totalTokens: 25, cacheReadTokens: 10 } }])
  const input = evaluationInput(ticket)
  expect(input.runs[0]).toMatchObject({ harness: 'dsh', assignmentId: 'a1', sessionId: session.id, eventSeq: event.seq, servedModel: served })
  expect(input.unknowns).not.toContain('served_model:dsh')
  expect(input.dimensions.resources.costUSD).toBeUndefined()
  expect(ticket.execution?.qualityReviews).toBeUndefined()
})

it.each([
  undefined,
  { response: response({ responseModel: undefined }) },
  { response: response({ responseModel: '  ' }) },
  { response: response({ responseModel: 123 }) },
  { response: response({ version: 1 }) },
  { response: response({ kind: 'other-adapter' }) },
  { response: response({ provider: 'another-provider' }) },
  { response: response({ model: 'another-request' }) },
])('keeps missing or unbound response identity unknown: %j', replay => {
  start()
  settle({ replay })
  expect(runs()[0]).toMatchObject({ requestedModel: requested, status: 'finished' })
  expect(runs()[0]?.servedModel).toBeUndefined()
  expect(runs()[0]?.models).toBeUndefined()
  expect(runs()[0]?.usage).toBeUndefined()
  expect(evaluationInput(ticket).unknowns).toContain('served_model:dsh')
  ticket.assignments[0]!.report = { state: 'ready', summary: 'done', at: new Date().toISOString() }
  expect(() => validateQualityReview(ticket, { ...review(), model: requested })).toThrow('served-model')
})

it('does not substitute a model from Ticket constraints or settings when the adapter omits responseModel', () => {
  ticket.execution!.harness = { harness: 'dsh', model: served }
  start()
  settle({ replay: { response: response({ responseModel: undefined }) } })
  expect(runs()[0]?.servedModel).toBeUndefined()
  ticket.assignments[0]!.report = { state: 'ready', summary: 'done', at: new Date().toISOString() }
  expect(() => validateQualityReview(ticket, review())).toThrow('served-model')
})

it('retains several attempts in one step, redacts a failure and does not convert it to quality', () => {
  start()
  const failed = publish(session.append('assistant/attempt', { turn: 1, step: 1,
    stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'finish', reason: { kind: 'error',
      failure: { code: 'INVALID_CREDENTIAL', message: '401 Bearer secret-token sk-abcdefghijklmnop', requestId: ProviderRequestId('gateway-rid') } } } }] }))
  settle({ replay: { response: response() } })
  expect(runs()).toHaveLength(2)
  expect(runs()[0]).toMatchObject({ eventSeq: failed.seq, status: 'failed', error: '401 Bearer [redacted] [redacted credential]' })
  expect(runs()[0]?.requestedModel).toBeUndefined()
  expect(runs()[0]?.servedModel).toBeUndefined()
  expect(evaluationInput(ticket).runs[0]?.requestId).toBe('gateway-rid')
  expect(evaluationInput(ticket).dimensions.availability.failures).toEqual([{ harness: 'dsh', category: 'authentication' }])
  expect(evaluationInput(ticket).dimensions.quality.basis).toBe('none')
})

it.each([{ interrupted: true as const }, { finish: { kind: 'max-tokens' as const } },
  { finish: { kind: 'aborted' as const, failure: { code: 'ABORTED', message: 'cancelled' } } }])(
  'does not accept an incomplete model response as finished execution: %j', options => {
    start()
    settle({ ...options, replay: { response: response() } })
    expect(runs()[0]?.status).toBe('unverified')
    ticket.assignments[0]!.report = { state: 'ready', summary: 'done', at: new Date().toISOString() }
    expect(() => validateQualityReview(ticket, review())).toThrow('finished')
  })

it('requires the report, Assignment, Harness and served model to match even after a verified response', () => {
  start()
  settle({ replay: { response: response() } })
  expect(() => validateQualityReview(ticket, review())).toThrow('report')
  ticket.assignments[0]!.report = { state: 'ready', summary: 'done', at: new Date().toISOString() }
  expect(validateQualityReview(ticket, { ...review(), verdict: 'unknown' }).id).toBe('review')
  const liveReview = review()
  expect(validateQualityReview(ticket, liveReview)).toEqual(liveReview)
  expect(evaluationInput(ticket).dimensions.quality.basis).toBe('ready')
  for (const over of [{ model: requested }, { assignmentId: 'a2' }, { harness: 'codex' as const }, { evidenceRefs: ['other'] }])
    expect(() => validateQualityReview(ticket, { ...review(), ...over })).toThrow()
  expect(ticket.execution?.qualityReviews).toBeUndefined()
})

it('keeps a late response on its original Assignment and does not credit its replacement', () => {
  start()
  ticket.assignments[0]!.state = 'ended'
  ticket.assignments.push({ id: 'a2', state: 'running', createdAt: new Date().toISOString() })
  settle({ replay: { response: response() } })
  expect(runs()[0]?.assignmentId).toBe('a1')
  expect(evaluationInput(ticket).dimensions.evidence.confidence).toBe('claimed')
  publish(session.append('step/end', { turn: 1, step: 1 }))
  start(2)
  settle({ turn: 2 })
  expect(runs().map(run => run.assignmentId)).toEqual(['a1', 'a2'])
})

it('deduplicates an observed settlement using its Session and event sequence', () => {
  start()
  const event = settle({ replay: { response: response() } })
  publish(event)
  expect(runs()).toHaveLength(1)
})

it('retains a new attempt if an externally deleted Session is recreated with the same id and sequence', () => {
  const time = vi.spyOn(Date, 'now').mockReturnValue(1000)
  start()
  settle({ replay: { response: response() } })
  time.mockReturnValue(2000)
  session = Session.create(session.id)
  agents.set(session.id, { session })
  start()
  settle()
  expect(runs()).toHaveLength(2)
  expect(runs()[0]?.eventSeq).toBe(runs()[1]?.eventSeq)
  expect(runs()[0]?.at).not.toBe(runs()[1]?.at)
  expect(runs()[1]?.servedModel).toBeUndefined()
})

it('ignores history without an observed step and unrelated or replaced Session instances', () => {
  settle({ replay: { response: response() } })
  expect(runs()).toEqual([])
  start()
  const unrelated = Session.create(SessionId('main'))
  agents.set(unrelated.id, { session: unrelated })
  publish(unrelated.append('step/start', { turn: 1, step: 1 }), unrelated)
  const original = session
  session = unrelated
  settle({ replay: { response: response() } })
  session = original
  agents.set(session.id, { session: Session.create(session.id) })
  settle({ replay: { response: response() } })
  expect(runs()).toEqual([])
})

it('stops attributing settlements after the step closes or when no live Assignment entered it', () => {
  start()
  publish(session.append('step/end', { turn: 1, step: 1 }))
  settle()
  ticket.ended = { at: new Date().toISOString(), by: 'human', outcome: 'stopped' }
  start(2)
  settle({ turn: 2 })
  expect(runs()).toEqual([])
})

it.each(['codex', 'grok', 'agy'] as const)('preserves the latest %s ready-gate receipt and migrates singleton history', harness => {
  const receipt: HarnessRun = { harness, assignmentId: 'a1', status: 'finished', servedModel: 'cli-model' }
  ticket.execution!.harnessRun = receipt
  start()
  settle({ replay: { response: response() } })
  expect(ticket.execution?.harnessRun).toEqual(receipt)
  expect(runs()).toHaveLength(2)
  expect(runs()[0]).toEqual(receipt)
})
