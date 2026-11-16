/**
 * Lightweight, explainable resource-aware candidate ordering for the Router (P1-S7).
 *
 * It only consumes trustworthy values that a source actually reported. A value the source did not return stays `unknown`
 * and never becomes a number, so no cost, quota or cache score is invented. Comparable validated reviews can reorder
 * evidence-backed candidates; incomplete quality remains provisional.
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
 * The logical model id used everywhere for authorization and channel matching. A role model can be provider-qualified
 * (e.g. `auto/deepseek-v4.1-flash` while the observed served model is `deepseek-v4.1-flash`); comparing the last path
 * segment keeps a checked box and the real dispatch on the same id instead of rejecting a name mismatch.
 */
export const logicalModelId = (model?: string): string | undefined => model ? model.split('/').at(-1) : undefined

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
  const configuredSelection = ranked[0]
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
    parts.push(selected.candidate.required
      ? `Selected ${label} by user-specified requirement`
      : selected !== configuredSelection || selected.candidate.priority === undefined
      ? `Selected ${label} using comparable calibrated quality evidence (${options.quality!.context.ruleVersion}); availability remains independent`
      : `Selected ${label} by configured priority ${selected.candidate.priority}${selected.candidate.reading?.state === 'available' ? ' with a known available reading' : ' with availability unknown'}`)
    if (excluded.some(item => item.excludedBecause === 'exhausted' || item.excludedBecause === 'rate-limited'))
      parts.push('resource state excludes known unavailable candidates')
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
  /** Per-account detail when several Magpie accounts serve this one logical model; top-level availability is the aggregate. */
  accounts?: { account_ref?: string; availability: Availability; remaining?: number; resets_at?: string }[]
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

  // Fold per-account observations into one logical channel per (model, provider): several Magpie accounts that serve the
  // same model become one candidate row (their per-account quota stays as detail) instead of duplicate rows.
  interface ChannelGroup { model: string; provider?: string; accounts: { account_ref?: string; reading?: AvailabilityReading }[] }
  const groups = new Map<string, ChannelGroup>()
  const usage = Array.isArray(data.request_usage) ? data.request_usage : []
  for (const group of usage) {
    if (!isRecord(group)) continue
    const model = text(group.served_model) ?? text(group.requested_model)
    if (!model) continue
    const provider = text(group.provider)
    const ref = text(group.account_ref)
    const key = `${model}\u0000${provider ?? ''}`
    let entry = groups.get(key)
    if (!entry) { entry = { model, ...(provider ? { provider } : {}), accounts: [] }; groups.set(key, entry) }
    const reading = ref ? byAccount.get(ref) : undefined
    entry.accounts.push({ ...(ref ? { account_ref: ref } : {}), ...(reading ? { reading } : {}) })
  }
  // A group with one account keeps that account's exact reading (remaining/resets_at/evidence). Several accounts aggregate:
  // available when any account is available; unknown when any account has no trustworthy reading (partial exhaustion must NOT
  // be reported as a fully exhausted channel — an unknown account may still serve); only exhausted/rate-limited when every
  // account is known and none is available.
  const aggregateReading = (accounts: ChannelGroup['accounts']): AvailabilityReading | undefined => {
    if (accounts.length === 1) return accounts[0]!.reading
    const states = accounts.map(account => account.reading?.state ?? 'unknown')
    if (states.includes('available'))
      return { state: 'available', evidence: `at least one of ${accounts.length} Magpie accounts is available` }
    if (states.includes('unknown'))
      return { state: 'unknown', evidence: `${states.filter(state => state === 'unknown').length} of ${accounts.length} Magpie accounts have no trustworthy reading` }
    if (states.every(state => state === 'rate-limited')) return { state: 'rate-limited', evidence: 'every Magpie account is rate-limited' }
    return { state: 'exhausted', evidence: 'every Magpie account is exhausted' }
  }
  const candidates: RouteCandidate[] = []
  const meta = new Map<RouteCandidate, { provider?: string; account_ref?: string; accounts: ChannelGroup['accounts'] }>()
  for (const entry of groups.values()) {
    const reading = aggregateReading(entry.accounts)
    const linked = entry.accounts.some(account => account.account_ref)
    const candidate: RouteCandidate = {
      harness: 'dsh', model: entry.model, capable: true,
      ...(reading ? { reading } : { unknownReason: linked ? 'no matching quota snapshot for this account' : 'account not linked to a quota snapshot' }),
    }
    meta.set(candidate, {
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.accounts.length === 1 && entry.accounts[0]!.account_ref ? { account_ref: entry.accounts[0]!.account_ref } : {}),
      accounts: entry.accounts,
    })
    candidates.push(candidate)
  }

  const decision = rankRouteCandidates(candidates)
  // Every observed channel is shown, including one excluded as exhausted, so the Router sees the real evidence and why.
  const observedChannels: RoutingChannel[] = decision.evaluated.map(item => {
    const reading = item.candidate.reading
    const channel = meta.get(item.candidate)
    const accounts = channel?.accounts.map(account => ({
      ...(account.account_ref ? { account_ref: account.account_ref } : {}),
      availability: account.reading?.state ?? ('unknown' as Availability),
      ...(account.reading?.remaining !== undefined ? { remaining: account.reading.remaining } : {}),
      ...(account.reading?.resetsAt ? { resets_at: account.reading.resetsAt } : {}),
    }))
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
      ...(accounts && accounts.length > 1 ? { accounts } : {}),
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

/**
 * The parts of the live model catalog that discovery needs, structurally typed so this module stays framework-free.
 * `routableProviders` names the providers whose catalog actually loaded, so a model under another provider is discovered
 * but not executable.
 */
export interface ModelCatalogInput {
  readonly groups: readonly { readonly id: string; readonly name: string; readonly models: readonly { readonly id: string }[] }[]
  readonly routableProviders?: readonly string[]
}

/** One model found among the catalog, Magpie or a Harness's own data, with the state the panel must distinguish. */
export interface ModelDiscovery {
  harness: HarnessName
  provider: string
  model: string
  /** Whether this model can actually be dispatched by its harness right now. */
  dispatchable: boolean
  availability: Availability
  /** `executable` (dispatchable, known availability), `availability-unknown` (dispatchable, no reading) or `discovered`. */
  state: 'executable' | 'availability-unknown' | 'discovered'
  reason: string
}

const discoveryState = (dispatchable: boolean, availability: Availability): ModelDiscovery['state'] =>
  !dispatchable ? 'discovered' : availability === 'unknown' ? 'availability-unknown' : 'executable'

/**
 * Merge the model catalog with the Magpie routing projection. Real DSH dispatch uses only the configured
 * `settings().executor.model`, so only that exact model becomes a dispatchable channel; every other catalog model
 * (and any Magpie-observed model that is not the configured route) stays visible as discovered-only so it never poses
 * as an independently dispatchable or authorizable channel. When no DSH route is configured, no DSH model is
 * dispatchable. Magpie-served readings are preserved. The catalog only covers DSH LLM routes; Codex/Grok/AGY are
 * reported separately per Harness.
 */
export function discoverModelSurface(catalog: ModelCatalogInput | undefined, routing: RoutingSignals,
  dshRoute?: { provider?: string; model?: string } | null): {
  channels: RoutingChannel[]
  discovered: ModelDiscovery[]
} {
  const modelKey = (model: string): string => logicalModelId(model) ?? model
  const routeModel = dshRoute?.model ? modelKey(dshRoute.model) : undefined
  const routeProvider = dshRoute?.provider
  const isDispatchRoute = (provider: string | undefined, model: string): boolean =>
    routeModel !== undefined && modelKey(model) === routeModel
    && (routeProvider === undefined || provider === undefined || provider === routeProvider)
  const channels = new Map<string, RoutingChannel>()
  const discovered = new Map<string, ModelDiscovery>()
  if (routeModel !== undefined) {
    const observedRoute = routing.observed_channels.find(channel => channel.harness === 'dsh'
      && modelKey(channel.model) === routeModel
      && (routeProvider === undefined || channel.provider === undefined || channel.provider === routeProvider))
    const availability = observedRoute?.availability ?? ('unknown' as Availability)
    if (observedRoute) channels.set(routeModel, observedRoute)
    else channels.set(routeModel, { harness: 'dsh', model: dshRoute!.model!,
      ...(routeProvider ? { provider: routeProvider } : {}), availability: 'unknown', selectable: true,
      reason: '[configured executor] the configured DSH dispatch route; no availability reading yet' })
    discovered.set(routeModel, { harness: 'dsh', provider: routeProvider ?? observedRoute?.provider ?? 'dsh',
      model: dshRoute!.model!, dispatchable: true, availability, state: discoveryState(true, availability),
      reason: observedRoute?.reason ?? '[configured executor] the configured DSH dispatch route; no availability reading yet' })
  }
  for (const channel of routing.observed_channels) {
    const key = modelKey(channel.model)
    if (discovered.has(key)) continue
    const dispatchable = isDispatchRoute(channel.provider, channel.model)
    discovered.set(key, { harness: channel.harness, provider: channel.provider ?? channel.harness, model: channel.model,
      dispatchable, availability: channel.availability, state: discoveryState(dispatchable, channel.availability), reason: channel.reason })
  }
  for (const group of catalog?.groups ?? []) {
    for (const entry of group.models) {
      const model = modelKey(entry.id)
      const dispatchable = isDispatchRoute(group.id, entry.id)
      const observed = routing.observed_channels.find(channel => channel.harness === 'dsh' && modelKey(channel.model) === model)
      const availability = observed?.availability ?? ('unknown' as Availability)
      if (dispatchable && !channels.has(model)) {
        channels.set(model, { harness: 'dsh', model, provider: group.name, availability,
          selectable: availability !== 'exhausted' && availability !== 'rate-limited',
          reason: `[configured executor] ${group.name} lists the DSH dispatch route; no availability reading yet` })
      }
      const reason = !dispatchable
        ? observed ? observed.reason : `[catalog] ${group.name} lists this model; it is not the configured DSH dispatch route`
        : observed ? observed.reason : `[catalog] ${group.name} lists the DSH dispatch route; no availability reading yet`
      discovered.set(model, { harness: 'dsh', provider: group.name, model, dispatchable, availability,
        state: discoveryState(dispatchable, availability), reason })
    }
  }
  return { channels: [...channels.values()], discovered: [...discovered.values()] }
}

/** Aggregate several observed readings without turning a partially-unknown set into a false "exhausted". */
function combineAvailabilityStates(states: readonly Availability[], count: number, what: string): AvailabilityReading {
  if (!count) return { state: 'unknown', evidence: `no ${what} reading` }
  if (states.includes('available')) return { state: 'available', evidence: `at least one of ${count} ${what} is available` }
  if (states.includes('unknown'))
    return { state: 'unknown', evidence: `${states.filter(state => state === 'unknown').length} of ${count} ${what} have no trustworthy reading` }
  if (states.every(state => state === 'rate-limited')) return { state: 'rate-limited', evidence: `every ${what} is rate-limited` }
  return { state: 'exhausted', evidence: `every ${what} is exhausted` }
}

/**
 * Normalize each Harness's known availability from the readers that actually exist, for the panel's overview. Magpie
 * channels describe DSH; Codex has an independent quota reader; Grok and AGY expose no readable quota, so they stay explicitly
 * unknown rather than being assumed healthy. This is a Harness-level summary; dispatch must use `availabilityReadingFor` so a
 * specific model is checked against its own logical channel rather than "any account somewhere in the Harness".
 */
export function summarizeHarnessAvailability(input: { magpie?: unknown; codex?: unknown }): Record<HarnessName, AvailabilityReading> {
  const routing = summarizeRoutingSignals(input.magpie)
  const dshChannels = routing.observed_channels.filter(channel => channel.harness === 'dsh')
  const codex = summarizeCodexQuotaSignals(input.codex ?? { status: 'unknown' })
  return {
    dsh: combineAvailabilityStates(dshChannels.map(channel => channel.availability), dshChannels.length, 'Magpie channel'),
    codex: { state: codex.availability, evidence: codex.reason },
    grok: { state: 'unknown', evidence: 'Grok quota is not readable; availability is unknown' },
    agy: { state: 'unknown', evidence: 'AGY quota is not readable; availability is unknown' },
  }
}

/**
 * The availability of the specific logical route being dispatched: for DSH/Magpie, only the channel(s) of the selected model
 * (never "some account in the Harness is available"); other Harnesses use their reader. Unknown stays unknown.
 */
export function availabilityReadingFor(input: { magpie?: unknown; codex?: unknown }, harness: HarnessName,
  model?: string): AvailabilityReading {
  if (harness !== 'dsh') return summarizeHarnessAvailability(input)[harness]
  const channels = summarizeRoutingSignals(input.magpie).observed_channels
    .filter(channel => channel.harness === 'dsh' && (model === undefined || logicalModelId(channel.model) === logicalModelId(model)))
  if (!channels.length) return { state: 'unknown', evidence: model ? `no Magpie channel for ${model}` : 'no Magpie channel reading' }
  return combineAvailabilityStates(channels.map(channel => channel.availability), channels.length, model ? `Magpie channel for ${model}` : 'Magpie channel')
}

/**
 * Why the Harness a router chose must not be accepted right now: only a KNOWN exhausted or rate-limited reading blocks it.
 * Unknown availability never blocks, and a person's explicit Harness/model is preserved — the caller reports the blocker so
 * the Router can choose an authorized available resource instead of this code silently substituting one.
 */
export function harnessAcceptBlocker(spec: { harness: HarnessName; model?: string; forbid4a?: boolean; allowFallback?: boolean },
  reading: AvailabilityReading): string | undefined {
  const candidate: RouteCandidate = { harness: spec.harness, ...(spec.model ? { model: spec.model } : {}), capable: true, required: true, reading }
  const evaluation = rankRouteCandidates([candidate], { allowFallback: spec.allowFallback === true }).evaluated[0]!
  if (evaluation.excludedBecause === 'exhausted' || evaluation.excludedBecause === 'rate-limited')
    return `Chosen ${spec.harness}${spec.model ? `/${spec.model}` : ''} is known ${evaluation.excludedBecause}: ${evaluation.reasons.join('; ')}.`
      + ' Choose an authorized available resource or call orchestrator_rank_candidates.'
  return undefined
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
    // An absent baseline reads as unknown, so a newly seen model with no reading is not reported as a change; a real
    // transition (unknown→available, available→exhausted) is.
    const beforeState = previous?.availability[channel] ?? 'unknown'
    if (beforeState !== state) changed.push({ channel, from: beforeState, to: state })
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
