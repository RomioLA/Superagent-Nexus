/** P1-S7 lightweight resource-aware routing: trustworthy signals decide, unknown stays unknown, explicit constraints win. */
import { expect, it } from 'vitest'
import { availabilityFromWindows, rankRouteCandidates, summarizeRoutingSignals, type RouteCandidate } from '../src/app/routing.ts'
import { readResource } from '../src/app/resources.ts'

const candidate = (overrides: Partial<RouteCandidate> & Pick<RouteCandidate, 'harness' | 'priority'>): RouteCandidate =>
  ({ capable: true, ...overrides })
const available = (remaining?: number) => ({ state: 'available' as const, ...(remaining !== undefined ? { remaining } : {}), evidence: `quota window remaining=${remaining ?? 'n/a'}` })
const exhausted = (resetsAt?: string) => ({ state: 'exhausted' as const, remaining: 0, ...(resetsAt ? { resetsAt } : {}), evidence: 'quota window exhausted (remaining=0)' })

it('normalizes only reported quota windows and invents no number', () => {
  expect(availabilityFromWindows([]).state).toBe('unknown')
  expect(availabilityFromWindows([{ availability: 'unknown', remaining: null }]).state).toBe('unknown')
  const done = availabilityFromWindows([{ availability: 'exhausted', remaining: 0, resets_at: '2026-11-13T00:00:00Z' }])
  expect(done).toMatchObject({ state: 'exhausted', remaining: 0, resetsAt: '2026-11-13T00:00:00Z' })
  expect(availabilityFromWindows([{ availability: 'remaining', remaining: 42 }])).toMatchObject({ state: 'available', remaining: 42 })
  // A window that only carries an unknown availability is not treated as available or zero.
  expect(availabilityFromWindows([{ availability: 'unknown' }])).toMatchObject({ state: 'unknown' })
})

it('lets a trustworthy exhausted reading change the choice, while an available reading keeps configured priority', () => {
  const blocked = rankRouteCandidates([
    candidate({ harness: 'dsh', model: 'm-a', priority: 0, reading: exhausted('2026-11-13T00:00:00Z') }),
    candidate({ harness: 'dsh', model: 'm-b', priority: 1, reading: available(10) }),
  ])
  expect(blocked.selected?.candidate.model).toBe('m-b')
  expect(blocked.ranked.map(item => item.candidate.model)).toEqual(['m-b'])
  expect(blocked.reason).toContain('dsh/m-a (exhausted)')

  const free = rankRouteCandidates([
    candidate({ harness: 'dsh', model: 'm-a', priority: 0, reading: available(10) }),
    candidate({ harness: 'dsh', model: 'm-b', priority: 1, reading: available(50) }),
  ])
  expect(free.selected?.candidate.model).toBe('m-a')
})

it('never feeds an unknown availability into a numeric score: configured priority still decides', () => {
  const decision = rankRouteCandidates([
    candidate({ harness: 'dsh', model: 'm-a', priority: 0, unknownReason: 'no quota reading' }),
    candidate({ harness: 'dsh', model: 'm-b', priority: 1, reading: available(5) }),
  ])
  // Unknown is not demoted below a known-available candidate: priority 0 wins and the reason says it is unknown.
  expect(decision.selected?.candidate.model).toBe('m-a')
  expect(decision.selected?.reasons.join(' ')).toContain('[configured] priority=0')
  expect(decision.unknown.join(' ')).toContain('dsh/m-a')
})

it('reports resource evidence without selecting when priority is absent, and ranks a configured priority first', () => {
  const unconfigured = [
    candidate({ harness: 'dsh', model: 'm-a', unknownReason: 'no quota reading' }),
    candidate({ harness: 'dsh', model: 'm-b', reading: available(5) }),
  ]
  const evidence = rankRouteCandidates(unconfigured)
  expect(evidence.selected).toBeUndefined()
  expect(evidence.ranked.map(item => item.candidate.model)).toEqual(['m-b', 'm-a'])
  expect(evidence.reason).toContain('No trustworthy priority: only resource evidence is reported')
  expect(evidence.evaluated.every(item => item.reasons.every(reason => !reason.includes('[configured]')))).toBe(true)

  const configured = rankRouteCandidates([
    ...unconfigured,
    candidate({ harness: 'dsh', model: 'm-c', priority: 5, unknownReason: 'no quota reading' }),
  ])
  expect(configured.selected?.candidate.model).toBe('m-c')
  expect(configured.ranked.map(item => item.candidate.model)).toEqual(['m-c', 'm-b', 'm-a'])
})

it('keeps explicit Harness, model and no-fallback constraints from being overridden', () => {
  const forbidden = rankRouteCandidates([
    candidate({ harness: 'agy', model: '3.8f', priority: 0, forbidden: true, reading: available() }),
    candidate({ harness: 'dsh', model: 'm', priority: 1, reading: available() }),
  ])
  expect(forbidden.selected?.candidate.harness).toBe('dsh')
  expect(forbidden.ranked.some(item => item.candidate.harness === 'agy')).toBe(false)

  // A required Harness that is unavailable is reported blocked, never silently replaced.
  const held = rankRouteCandidates([
    candidate({ harness: 'agy', model: '3.8f', priority: 0, required: true, reading: exhausted() }),
    candidate({ harness: 'dsh', model: 'm', priority: 1, reading: available() }),
  ])
  expect(held.selected).toBeUndefined()
  expect(held.reason).toContain('fallback is not authorized')

  // Only explicit authorization permits falling back off the required Harness.
  const fellBack = rankRouteCandidates([
    candidate({ harness: 'agy', model: '3.8f', priority: 0, required: true, reading: exhausted() }),
    candidate({ harness: 'dsh', model: 'm', priority: 1, reading: available() }),
  ], { allowFallback: true })
  expect(fellBack.selected?.candidate.harness).toBe('dsh')

  // Allowing fallback never lets another candidate outrank a required one that is itself usable.
  const keptRequired = rankRouteCandidates([
    candidate({ harness: 'agy', model: '3.8f', priority: 5, required: true, reading: available() }),
    candidate({ harness: 'dsh', model: 'm', priority: 0, reading: available() }),
  ], { allowFallback: true })
  expect(keptRequired.selected?.candidate.harness).toBe('agy')

  // A 4A candidate needs explicit authorization and is otherwise excluded, not upgraded to silently.
  const no4a = rankRouteCandidates([candidate({ harness: 'agy', model: '4a', priority: 0, reading: available() })])
  expect(no4a.selected).toBeUndefined()
  expect(no4a.ranked).toHaveLength(0)
  expect(rankRouteCandidates([candidate({ harness: 'agy', model: '4a', priority: 0, reading: available() })], { allow4a: true }).selected?.candidate.model).toBe('4a')

  // A candidate that misses the capability is never selectable even when it is the only one.
  expect(rankRouteCandidates([candidate({ harness: 'dsh', model: 'm', priority: 0, capable: false, reading: available() })]).selected).toBeUndefined()
})

it('states its reason in separate evidence, configuration and constraint terms', () => {
  const decision = rankRouteCandidates([
    candidate({ harness: 'agy', model: '3.8f', priority: 1, required: true, reading: available(3) }),
    candidate({ harness: 'dsh', model: 'm', priority: 0, reading: exhausted() }),
  ])
  const reasons = decision.selected!.reasons.join(' | ')
  expect(reasons).toContain('[constraint] agy/3.8f required by the person')
  expect(reasons).toContain('[evidence] quota window remaining=3')
  expect(reasons).toContain('[configured] priority=1')
  expect(decision.reason).toContain('excluded dsh/m (exhausted)')
})

it('projects observed Magpie channels into an explainable routing view without inventing cost or cache', () => {
  const snapshot = {
    status: 'partial', checked_at: '2026-11-12T19:00:00Z',
    account_quotas: [
      { provider: 'deepseek', account_ref: 'ref-a', state: 'ok', windows: [{ unit: 'day', remaining: 0, resets_at: '2026-11-13T00:00:00Z' }] },
      { provider: 'deepseek', account_ref: 'ref-b', state: 'ok', windows: [{ unit: 'day', remaining: 500 }] },
    ],
    request_usage: [
      { provider: 'deepseek', served_model: 'model-a', account_ref: 'ref-a' },
      { provider: 'deepseek', served_model: 'model-b', account_ref: 'ref-b' },
    ],
    cost_routing: 'unknown_no_verified_usd_cost_or_budget_boundary', cache_hit_rate: null,
    cache_hit_rate_status: 'unknown_no_reliable_denominator',
  }
  const routing = summarizeRoutingSignals(snapshot)
  expect(routing.source).toBe('magpie')
  expect(routing.preferred_channel).toBeNull()
  expect(routing.observed_channels).toHaveLength(2) // every observed channel, including the exhausted one as excluded
  const byModel = Object.fromEntries(routing.observed_channels.map(channel => [channel.model, channel]))
  expect(byModel['model-a']).toMatchObject({ availability: 'exhausted', resets_at: '2026-11-13T00:00:00Z', selectable: false, excluded_because: 'exhausted' })
  expect(byModel['model-b']).toMatchObject({ availability: 'available', remaining: 500, selectable: true })
  for (const channel of routing.observed_channels) expect(channel.priority).toBeUndefined()
  expect(routing.unknown).toEqual(expect.arrayContaining(['cost_usd', 'cache_hit_rate', 'agy_quota', 'grok_quota', 'codex_quota']))
  expect(JSON.stringify(routing)).not.toContain('900') // no derived total from the two quota windows
})

it.each([['model-a', 'model-b'], ['model-b', 'model-a']])('does not treat observed channel order %s, %s as priority', (first, second) => {
  const routing = summarizeRoutingSignals({
    status: 'ok',
    account_quotas: [{ account_ref: 'ref-a', state: 'ok', windows: [{ remaining: 500 }] }],
    request_usage: [first, second].map(model => ({ served_model: model, account_ref: 'ref-a' })),
  })
  expect(routing.preferred_channel).toBeNull()
  expect(routing.observed_channels).toHaveLength(2)
  for (const channel of routing.observed_channels) {
    expect(channel).toMatchObject({ availability: 'available', remaining: 500, selectable: true })
    expect(channel).not.toHaveProperty('priority')
    expect(channel.reason).not.toContain('[configured]')
  }
})

it('reports a not-configured Magpie source as unknown rather than healthy', () => {
  const routing = summarizeRoutingSignals({ status: 'not-configured' })
  expect(routing.observed_channels).toEqual([])
  expect(routing.preferred_channel).toBeNull()
  expect(routing.unknown).toEqual(expect.arrayContaining(['cost_usd', 'cache_hit_rate', 'agy_quota', 'grok_quota', 'codex_quota']))
})

it('serves the routing projection from the existing models resource alongside the raw snapshot', async () => {
  const snapshot = {
    status: 'partial',
    account_quotas: [{ provider: 'deepseek', account_ref: 'ref-a', state: 'ok', windows: [{ remaining: 0 }] },
      { provider: 'deepseek', account_ref: 'ref-b', state: 'ok', windows: [{ remaining: 7 }] }],
    request_usage: [{ provider: 'deepseek', served_model: 'model-a', account_ref: 'ref-a' },
      { provider: 'deepseek', served_model: 'model-b', account_ref: 'ref-b' }],
    cost_routing: 'unknown_no_verified_usd_cost_or_budget_boundary', cache_hit_rate: null,
    cache_hit_rate_status: 'unknown_no_reliable_denominator',
  }
  const result = await readResource({
    masterId: 'main', settings: {},
    store: { settings: () => ({ eval: { model: { provider: 'magpie', model: 'deepseek-v4.1-flash' } },
      executor: { model: { provider: 'magpie', model: 'deepseek-v4.1-flash' } } }) },
    context: { sessionController: { modelCatalog: async () => ({
      default: { provider: 'magpie', model: 'deepseek-v4.1-flash' },
      groups: [{ id: 'magpie', name: 'Magpie', models: [{ id: 'deepseek-v4.1-flash' }] }], failures: [],
    }) } },
    magpie: async () => snapshot,
  } as never, 'models', 0, undefined) as Record<string, any>
  expect(result.magpie).toEqual(snapshot)
  expect(result.routing).toMatchObject({ source: 'magpie', preferred_channel: null })
})
