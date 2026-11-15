/**
 * Lightweight, explainable resource-aware candidate ordering for the Router (P1-S7).
 *
 * It only consumes trustworthy values that a source actually reported. A value the source did not return stays `unknown`
 * and never becomes a number, so no cost, quota or cache score is invented. Real quality scoring and dynamic learning are
 * deferred to S9: this is a temporary, transparent rule set — not a second Router, Queue, database or scoring service.
 *
 * The rules are deliberately narrow:
 *  - A person's explicit requirement (a named Harness/model, `forbid4a`, "no fallback") is authoritative over any advice.
 *  - A candidate that misses the task capability or is explicitly forbidden is never selectable.
 *  - A candidate whose *known* availability is exhausted or rate-limited is not selectable; others stay in the race.
 *  - Among the rest the existing configured priority decides. `unknown` availability never re-orders across priorities;
 *    it is only reported so the reason can say what was not known.
 */
import { summarizeQuality, type QualityContext, type QualityReview } from './evaluation.ts'
import type { HarnessName } from '../core/index.ts'

/** Known availability of one candidate from a trustworthy reading; `unknown` means no usable signal was obtained. */
export type Availability = 'available' | 'exhausted' | 'rate-limited' | 'unknown'

/**
 * A normalized availability reading for one candidate. `remaining` and `resetsAt` are present only when the source named
 * them; an absent value is never filled with a guess or a zero.
 */
export interface AvailabilityReading {
  state: Availability
  /** Remaining quota, only when the source reported a finite number. */
  remaining?: number
  /** When the quota resets or runs out, only when the source named it. */
  resetsAt?: string
  /** The concrete field(s) the state came from, so a reason can quote real evidence rather than a summary judgement. */
  evidence: string
}

/** A candidate the Router may choose, carrying the explicit constraints a person gave and any reading actually obtained. */
export interface RouteCandidate {
  harness: HarnessName
  model?: string
  /** Trustworthy configured preference order, when named; lower is preferred among selectable candidates. */
  priority?: number
  /** Whether the candidate meets the task's capability requirement. A miss is never selectable. */
  capable: boolean
  /** The person explicitly required this Harness (or model); automatic advice keeps it and never substitutes silently. */
  required?: boolean
  /** The person explicitly forbade this candidate. */
  forbidden?: boolean
  /** Availability reading for this candidate, when one was actually obtained. */
  reading?: AvailabilityReading
  /** Why the reading is unknown, when there is no usable evidence. */
  unknownReason?: string
}

/** Explicit authorization switches a caller passes; all default to the safe, denying value. */
export interface RouteOptions {
  /** Comparable, calibrated evidence only; fixture mode is explicit and never the live default. */
  quality?: { context: QualityContext; reviews: readonly QualityReview[]; origin?: 'live' | 'fixture' }
  /** Explicit authorization to offer model=4a; otherwise a 4a candidate is never selectable. */
  allow4a?: boolean
  /** Whether an unavailable required candidate may fall back to another authorized one; omitted means no substitution. */
  allowFallback?: boolean
}

/** One candidate's assessed standing, with the evidence lines that produced it kept separate from configured priority. */
export interface CandidateEvaluation {
  candidate: RouteCandidate
  selectable: boolean
  excludedBecause?: 'forbidden' | 'incapable' | 'unauthorized-model' | 'exhausted' | 'rate-limited'
  /** `[evidence]` lines quote a real reading; `[configured]` lines state priority; `[constraint]` lines quote a person. */
  reasons: string[]
  unknown: string[]
}

export interface RouteDecision {
  selected?: CandidateEvaluation
  /** Every candidate's assessment in input order, selectable or excluded, so a caller can explain each channel. */
  evaluated: CandidateEvaluation[]
  /** The selectable candidates in selection order (the first is `selected` only when it has configured priority). */
  ranked: CandidateEvaluation[]
  /** Fields still unknown across the candidate set that were not used for any adjustment. */
  unknown: string[]
  reason: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined

/** Separate Codex account availability for the Router; it never enters Magpie channel ranking or model scoring. */
export interface CodexQuotaRoutingSignals {
  source: 'codex'
  status: 'available' | 'rate-limited' | 'unknown'
  availability: Availability
  checked_at?: string
  limit_id?: string
  ordinary_usage_allowed?: boolean
  rate_limit_reached_type?: string
  primary?: { availability: Availability; window_duration_mins?: number; used_percent?: number; remaining_percent?: number; resets_at?: string }
  secondary?: { availability: Availability; window_duration_mins?: number; used_percent?: number; remaining_percent?: number; resets_at?: string }
  error?: string
  reason: string
}

/** Project only the independent Codex snapshot fields the App Server actually returned. */
export function summarizeCodexQuotaSignals(snapshot: unknown): CodexQuotaRoutingSignals {
  const data = isRecord(snapshot) ? snapshot : {}
  const rawStatus = text(data.status)
  const status = rawStatus === 'available' || rawStatus === 'rate-limited' ? rawStatus : 'unknown'
  const availability: Availability = status === 'available' ? 'available' : status === 'rate-limited' ? 'rate-limited' : 'unknown'
  const window = (value: unknown) => {
    if (!isRecord(value)) return undefined
    const used = finite(value.used_percent)
    const remaining = finite(value.remaining_percent)
    const rawAvailability = text(value.availability)
    const state: Availability = rawAvailability === 'available' || rawAvailability === 'exhausted' || rawAvailability === 'rate-limited'
      ? rawAvailability : used === undefined ? 'unknown' : used >= 100 ? 'exhausted' : 'available'
    return {
      availability: state,
      ...(finite(value.window_duration_mins) !== undefined ? { window_duration_mins: finite(value.window_duration_mins) } : {}),
      ...(used !== undefined ? { used_percent: used } : {}),
      ...(remaining !== undefined ? { remaining_percent: remaining } : {}),
      ...(text(value.resets_at) ? { resets_at: text(value.resets_at) } : {}),
    }
  }
  const primary = window(data.primary)
  const secondary = window(data.secondary)
  const reached = text(data.rate_limit_reached_type)
  const ordinaryUsageAllowed = typeof data.ordinary_usage_allowed === 'boolean' ? data.ordinary_usage_allowed : undefined
  const error = text(data.error)
  const reason = status === 'rate-limited'
    ? reached ? `Codex rate limit reached: ${reached}`
      : ordinaryUsageAllowed === false ? 'Codex reports ordinary usage is not allowed'
        : 'A Codex quota window reports at least 100% used'
    : status === 'available'
      ? ordinaryUsageAllowed === true ? 'Codex reports ordinary usage is allowed' : 'Both reported Codex quota windows have remaining usage'
      : error ? `Codex quota is unknown because the read failed (${error})` : 'Codex account availability is unknown'
  return {
    source: 'codex', status, availability,
    ...(text(data.checked_at) ? { checked_at: text(data.checked_at) } : {}),
    ...(text(data.limit_id) ? { limit_id: text(data.limit_id) } : {}),
    ...(ordinaryUsageAllowed !== undefined ? { ordinary_usage_allowed: ordinaryUsageAllowed } : {}),
    ...(reached ? { rate_limit_reached_type: reached } : {}),
    ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}),
    ...(error ? { error } : {}), reason,
  }
}

/**
 * Derive a candidate's availability from quota windows a source reported (the shape Magpie's `windowView` produces).
 * Any exhausted window makes the candidate exhausted; otherwise a positive remaining makes it available; otherwise the
 * window data is not usable and the state stays `unknown` with no invented number.
 */
export function availabilityFromWindows(windows: unknown): AvailabilityReading {
  if (!Array.isArray(windows) || !windows.length) return { state: 'unknown', evidence: 'no quota window reported' }
  let exhausted: AvailabilityReading | undefined
  let available: AvailabilityReading | undefined
  for (const window of windows) {
    if (!isRecord(window)) continue
    const state = text(window.availability)
    const remaining = finite(window.remaining)
    const resetsAt = text(window.resets_at) ?? text(window.resetsAt)
    if (state === 'exhausted' || (remaining !== undefined && remaining <= 0)) {
      const amount = remaining !== undefined ? ` (remaining=${remaining})` : ''
      const evidence = resetsAt ? `quota window exhausted${amount}; resets_at=${resetsAt}` : `quota window exhausted${amount}`
      exhausted ??= { state: 'exhausted', ...(remaining !== undefined ? { remaining } : {}), ...(resetsAt ? { resetsAt } : {}), evidence }
    } else if (state === 'remaining' || (remaining !== undefined && remaining > 0)) {
      const evidence = remaining !== undefined ? `quota window remaining=${remaining}`
        : 'quota window availability=remaining'
      if (!available || (remaining !== undefined && (available.remaining === undefined || remaining < available.remaining)))
        available = { state: 'available', ...(remaining !== undefined ? { remaining } : {}), ...(resetsAt ? { resetsAt } : {}), evidence }
    }
  }
  return exhausted ?? available ?? { state: 'unknown', evidence: 'quota window reported no usable remaining/availability' }
}

/** Assess one candidate against the capability, explicit-constraint and availability rules. */
function evaluate(candidate: RouteCandidate, options: RouteOptions): CandidateEvaluation {
  const reasons: string[] = []
  const unknown: string[] = []
  const label = candidate.model ? `${candidate.harness}/${candidate.model}` : candidate.harness
  const excluded = (why: NonNullable<CandidateEvaluation['excludedBecause']>, reason: string): CandidateEvaluation =>
    ({ candidate, selectable: false, excludedBecause: why, reasons: [...reasons, reason], unknown })

  if (candidate.required) reasons.push(`[constraint] ${label} required by the person`)
  if (candidate.forbidden) return excluded('forbidden', `[constraint] ${label} forbidden by the person`)
  if (!candidate.capable) return excluded('incapable', `[capability] ${label} does not meet the task requirement`)
  // A 4a offer is a high-cost, separately authorized model; it is never selected without explicit authorization.
  if (candidate.model === '4a' && options.allow4a !== true)
    return excluded('unauthorized-model', `[constraint] model 4a is not authorized for automatic use`)

  const reading = candidate.reading
  if (reading?.state === 'exhausted') return excluded('exhausted', `[evidence] ${reading.evidence}`)
  if (reading?.state === 'rate-limited') return excluded('rate-limited', `[evidence] ${reading.evidence}`)
  if (reading?.state === 'available') reasons.push(`[evidence] ${reading.evidence}`)
  else unknown.push(`${label}: ${reading?.evidence ?? candidate.unknownReason ?? 'no availability reading'}`)

  if (candidate.priority !== undefined) reasons.push(`[configured] priority=${candidate.priority}`)
  return { candidate, selectable: true, reasons, unknown }
}

/** Order selectable candidates by configured priority, then by whether availability is known (`available` before `unknown`). */
function compare(a: CandidateEvaluation, b: CandidateEvaluation): number {
  const aPriority = a.candidate.priority
  const bPriority = b.candidate.priority
  if (aPriority !== undefined && bPriority !== undefined) {
    if (aPriority !== bPriority) return aPriority - bPriority
  } else if (aPriority !== undefined) return -1
  else if (bPriority !== undefined) return 1
  const rank = (item: CandidateEvaluation) => item.candidate.reading?.state === 'available' ? 0 : 1
  return rank(a) - rank(b)
}

/**
 * Rank candidates and pick one using only configured priority and trustworthy availability. Explicit requirements and 4A
 * authorization are hard constraints; an unavailable required candidate without authorized fallback yields no selection
 * (the caller reports a resource blocker) rather than a silent substitution.
 */
export function rankRouteCandidates(candidates: readonly RouteCandidate[], options: RouteOptions = {}): RouteDecision {
  const evaluated = candidates.map(candidate => evaluate(candidate, options))
  const required = evaluated.filter(item => item.candidate.required)
  const requiredSelectable = required.filter(item => item.selectable)
  const selectable = evaluated.filter(item => item.selectable)
  // A person's explicit requirement narrows the pool; another candidate is only eligible under authorized fallback, and only
  // when no required candidate is itself selectable.
  const pool = required.length ? (requiredSelectable.length ? requiredSelectable : options.allowFallback === true ? selectable : []) : selectable
  const ranked = [...pool].sort(compare)
  const quality = options.quality ? summarizeQuality(options.quality.reviews, options.quality.context, options.quality.origin) : []
  const standing = (item: CandidateEvaluation) => quality.find(row => row.harness === item.candidate.harness && row.model === item.candidate.model)
  // Keep unknown candidates in their configured slots; only comparable evidence-backed candidates change places.
  const slots = ranked.flatMap((item, index) => standing(item)?.status === 'evidence-backed' ? [index] : [])
  const supported = slots.map(index => ranked[index]!).sort((a, b) => {
    const verdict = (item: CandidateEvaluation) => standing(item)?.verdict === 'meets' ? 0 : 1
    return verdict(a) - verdict(b) || compare(a, b)
  })
  slots.forEach((index, position) => { ranked[index] = supported[position]! })
  const selected = ranked[0] && (ranked[0].candidate.priority !== undefined || standing(ranked[0])?.status === 'evidence-backed') ? ranked[0] : undefined
  const unknown = [...new Set(evaluated.flatMap(item => item.unknown))]

  const excluded = evaluated.filter(item => !item.selectable)
  const parts: string[] = []
  if (selected) {
    const label = selected.candidate.model ? `${selected.candidate.harness}/${selected.candidate.model}` : selected.candidate.harness
    parts.push(standing(selected)?.status === 'evidence-backed'
      ? `Selected ${label} using comparable calibrated quality evidence (${options.quality!.context.ruleVersion}); availability remains independent`
      : `Selected ${label} by configured priority ${selected.candidate.priority}${selected.candidate.reading?.state === 'available' ? ' with a known available reading' : ' with availability unknown'}`)
  } else if (ranked.length) {
    parts.push('No trustworthy priority: only resource evidence is reported')
  } else if (required.length) {
    const blocked = required.filter(item => !item.selectable).map(item => `${item.candidate.harness}${item.excludedBecause ? ` (${item.excludedBecause})` : ''}`)
    parts.push(`No authorized replacement: required ${blocked.join(', ')} is not selectable; ${options.allowFallback === true ? 'no legal available fallback meets the constraints' : 'fallback is not authorized'}`)
  } else if (!selectable.length) {
    parts.push('No selectable candidate: every candidate is forbidden, incapable or known unavailable')
  }
  const excludedText = excluded.map(item => `${item.candidate.harness}${item.candidate.model ? `/${item.candidate.model}` : ''} (${item.excludedBecause})`)
  if (excludedText.length) parts.push(`excluded ${excludedText.join(', ')}`)
  if (unknown.length) parts.push(`unknown ${unknown.map(item => item.split(':')[0]).join(', ')}`)

  return { ...(selected ? { selected } : {}), evaluated, ranked, unknown, reason: parts.join('; ') }
}

/** A per-channel view of the routing projection served to the main Session's `models` resource. */
export interface RoutingChannel {
  harness: HarnessName
  model: string
  provider?: string
  account_ref?: string
  priority?: number
  availability: Availability
  remaining?: number
  resets_at?: string
  selectable: boolean
  excluded_because?: CandidateEvaluation['excludedBecause']
  reason: string
}

/** The explainable resource projection the Router reads; it states what is known and what is still unknown. */
export interface RoutingSignals {
  source: 'magpie'
  status: string
  checked_at?: string
  /** Observed DSH/Magpie model channels, ranked with the same rules the pure ordering uses. */
  observed_channels: RoutingChannel[]
  preferred_channel: { harness: HarnessName; model: string; reason: string } | null
  /** Fields with no trustworthy value, listed so no one fills them with an estimate. */
  unknown: string[]
  note: string
}

const ROUTING_NOTE = 'Magpie covers only configured DSH/Magpie model channels. AGY, Grok and Codex use independent resources and '
  + 'never send AGY credentials through Magpie. Unknown fields are not estimated: report a resource blocker instead of a number.'

/**
 * Project a Magpie snapshot into an explainable routing view. It reuses only fields the snapshot already exposes
 * (`account_quotas`, `request_usage`, `keys`, cost/cache status) and fabricates nothing.
 */
export function summarizeRoutingSignals(snapshot: unknown): RoutingSignals {
  const data = isRecord(snapshot) ? snapshot : {}
  const status = text(data.status) ?? 'unknown'
  const checkedAt = text(data.checked_at)

  // Known availability per account, keyed by the secret-redacted reference the snapshot already uses.
  const byAccount = new Map<string, AvailabilityReading>()
  const quotas = Array.isArray(data.account_quotas) ? data.account_quotas : []
  for (const card of quotas) {
    if (!isRecord(card)) continue
    const ref = text(card.account_ref)
    if (!ref) continue
    // A card whose state is not `ok` is not a trustworthy quota reading.
    byAccount.set(ref, text(card.state) === 'ok' ? availabilityFromWindows(card.windows)
      : { state: 'unknown', evidence: `quota card state=${text(card.state) ?? 'unknown'}` })
  }

  // Build candidates from the model channels actually observed for these keys; unknown account linkage stays unknown.
  const candidates: RouteCandidate[] = []
  const meta = new Map<RouteCandidate, { provider?: string; account_ref?: string }>()
  const usage = Array.isArray(data.request_usage) ? data.request_usage : []
  usage.forEach(group => {
    if (!isRecord(group)) return
    const model = text(group.served_model) ?? text(group.requested_model)
    if (!model) return
    const ref = text(group.account_ref)
    const reading = ref ? byAccount.get(ref) : undefined
    const candidate: RouteCandidate = {
      harness: 'dsh', model, capable: true,
      ...(reading ? { reading } : { unknownReason: ref ? 'no matching quota snapshot for this account' : 'account not linked to a quota snapshot' }),
    }
    meta.set(candidate, { ...(text(group.provider) ? { provider: text(group.provider) } : {}), ...(ref ? { account_ref: ref } : {}) })
    candidates.push(candidate)
  })

  const decision = rankRouteCandidates(candidates)
  // Every observed channel is shown, including one excluded as exhausted, so the Router sees the real evidence and why.
  const observedChannels: RoutingChannel[] = decision.evaluated.map(item => {
    const reading = item.candidate.reading
    const channel = meta.get(item.candidate)
    return {
      harness: item.candidate.harness, model: item.candidate.model!,
      ...(item.candidate.priority !== undefined ? { priority: item.candidate.priority } : {}),
      ...(channel?.provider ? { provider: channel.provider } : {}),
      ...(channel?.account_ref ? { account_ref: channel.account_ref } : {}),
      availability: reading?.state ?? 'unknown',
      ...(reading?.remaining !== undefined ? { remaining: reading.remaining } : {}),
      ...(reading?.resetsAt ? { resets_at: reading.resetsAt } : {}),
      selectable: item.selectable, ...(item.excludedBecause ? { excluded_because: item.excludedBecause } : {}),
      reason: item.reasons.join('; '),
    }
  })

  const unknown = new Set(decision.unknown)
  // Harnesses and fields Magpie does not cover at all stay explicitly unknown rather than assumed healthy.
  for (const field of ['agy_quota', 'grok_quota', 'codex_quota', 'usd_budget_boundary']) unknown.add(field)
  const costRouting = text(data.cost_routing)
  if (costRouting === undefined || costRouting.startsWith('unknown')) unknown.add('cost_usd')
  const cacheStatus = text(data.cache_hit_rate_status)
  if (cacheStatus === undefined || cacheStatus.startsWith('unknown') || data.cache_hit_rate === null) unknown.add('cache_hit_rate')

  return {
    source: 'magpie', status, ...(checkedAt ? { checked_at: checkedAt } : {}),
    observed_channels: observedChannels,
    preferred_channel: decision.selected?.candidate.model
      ? { harness: decision.selected.candidate.harness, model: decision.selected.candidate.model, reason: decision.reason }
      : null,
    unknown: [...unknown], note: ROUTING_NOTE,
  }
}

/** A compact, comparable view of exactly what one model-surface refresh read, so a later refresh reports real changes. */
export interface ModelSurfaceSnapshot {
  /** Provider/model identities observed in the catalog. */
  catalog: string[]
  /** Availability state per observed channel, from a trustworthy reading only. */
  availability: Record<string, Availability>
  /** Each source's own status, so a failed read is never reported as "no change". */
  sources: Record<string, string>
}

export interface ModelSurfaceDiff {
  catalog: { added: string[]; removed: string[] }
  availability: { changed: { channel: string; from: Availability; to: Availability }[] }
  /** Catalog refresh, resource refresh and capability ranking are kept distinct; a new model has no inherited score. */
  capability: { new_without_evidence: string[]; note: string }
  sources: { name: string; status: string; changed: boolean }[]
  /** Sources that could not be read this refresh; an unreadable source is not evidence of no change. */
  unknown: string[]
}

/** Compare two actual model-surface reads; the first refresh (no previous snapshot) reports everything as added. */
export function diffModelSurface(previous: ModelSurfaceSnapshot | undefined, current: ModelSurfaceSnapshot): ModelSurfaceDiff {
  const catalogReadable = current.sources.catalog === 'ok'
  const before = new Set(previous?.catalog ?? [])
  const after = new Set(current.catalog)
  const added = catalogReadable ? current.catalog.filter(id => !before.has(id)) : []
  const removed = catalogReadable ? (previous?.catalog ?? []).filter(id => !after.has(id)) : []
  const changed: { channel: string; from: Availability; to: Availability }[] = []
  for (const [channel, state] of Object.entries(current.availability)) {
    const beforeState = previous?.availability[channel]
    if (beforeState !== state) changed.push({ channel, from: beforeState ?? 'unknown', to: state })
  }
  const sources = Object.entries(current.sources)
    .map(([name, status]) => ({ name, status, changed: previous?.sources[name] !== status }))
  const unknown = Object.entries(current.sources).filter(([, status]) => status !== 'ok').map(([name, status]) => `${name}:${status}`)
  return {
    catalog: { added, removed },
    availability: { changed },
    capability: { new_without_evidence: added,
      note: 'New models carry no quality evidence and do not inherit another model\'s ranking.' },
    sources, unknown,
  }
}

/** Advice for native continuation: resource fallback never bypasses an active writer or unreviewed side effects. */
export function planResourceFallback(candidates: readonly RouteCandidate[], options: RouteOptions,
  recovery: { oldWorkerActive: boolean; hasSideEffects: boolean; checked: boolean }) {
  const decision = rankRouteCandidates(candidates, options)
  const blocked = recovery.oldWorkerActive ? 'The previous Worker must reach its native cancellation safe point.'
    : recovery.hasSideEffects && !recovery.checked ? 'Inspect the existing workspace/Git/PR effects before continuing.'
    : !decision.selected ? decision.reason : undefined
  return { decision, status: blocked ? 'blocked' as const : 'ready' as const, ...(blocked ? { blocker: blocked } : {}),
    note: 'Advice only: reuse the existing Ticket/Session/workspace and native continuation; never repeat external effects. Unknown price/cache/quota values are not estimated.' }
}
