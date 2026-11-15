import { expect, it } from 'vitest'
import { parseCodexQuotaResponse } from '../src/app/codex-quota.ts'
import { readResource } from '../src/app/resources.ts'
import { summarizeCodexQuotaSignals } from '../src/app/routing.ts'

const checkedAt = '2026-11-13T04:00:00.000Z'

it('parses the App Server account response and derives remaining percentages only from reported usage', () => {
  const snapshot = parseCodexQuotaResponse({
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1794508412 },
      secondary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 1794609006 },
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 30, windowDurationMins: 300 } },
    },
    accountId: 'must-not-be-exposed',
  }, checkedAt)

  expect(snapshot).toMatchObject({
    status: 'available', checked_at: checkedAt, limit_id: 'codex', ordinary_usage_allowed: true,
    primary: { availability: 'available', window_duration_mins: 300, used_percent: 30, remaining_percent: 70,
      resets_at: new Date(1794508412 * 1000).toISOString() },
    secondary: { availability: 'available', window_duration_mins: 10080, used_percent: 13, remaining_percent: 87,
      resets_at: new Date(1794609006 * 1000).toISOString() },
    rate_limits_by_limit_id: { codex: { limit_id: 'codex', primary: { used_percent: 30, remaining_percent: 70 } } },
  })
  expect(JSON.stringify(snapshot)).not.toContain('must-not-be-exposed')
})

it('marks explicit limits and exhausted windows as unavailable', () => {
  const snapshot = parseCodexQuotaResponse({
    ordinaryUsageAllowed: false,
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1794508412 },
      secondary: { usedPercent: 4, windowDurationMins: 10080 },
      rateLimitReachedType: 'primary',
    },
  }, checkedAt)

  expect(snapshot.status).toBe('rate-limited')
  expect(snapshot).toMatchObject({
    rate_limit_reached_type: 'primary', ordinary_usage_allowed: false,
    primary: { availability: 'exhausted', used_percent: 100, remaining_percent: 0 },
  })
})

it('leaves absent quota fields unknown and does not invent percentages or reset times', () => {
  const snapshot = parseCodexQuotaResponse({
    rateLimits: {
      limitId: 'codex', primary: { windowDurationMins: 300 }, secondary: { windowDurationMins: 10080 },
    },
  }, checkedAt)

  expect(snapshot.status).toBe('unknown')
  expect(snapshot.primary).toEqual({ availability: 'unknown', window_duration_mins: 300 })
  expect(snapshot.secondary).toEqual({ availability: 'unknown', window_duration_mins: 10080 })
  expect(snapshot).not.toHaveProperty('ordinary_usage_allowed')
})

it('keeps Codex availability separate from Magpie signals and preserves the existing models data', async () => {
  const magpie = { status: 'partial', account_quotas: [{ account_ref: 'ref-a', state: 'ok', windows: [{ remaining: 0 }] }] }
  const codex = parseCodexQuotaResponse({
    ordinaryUsageAllowed: true,
    rateLimits: { limitId: 'codex', primary: { usedPercent: 30, windowDurationMins: 300 },
      secondary: { usedPercent: 13, windowDurationMins: 10080 } },
  }, checkedAt)
  const result = await readResource({
    masterId: 'main', settings: {},
    store: { tickets: { list: () => [] }, settings: () => ({ eval: { model: { provider: 'magpie', model: 'deepseek-v4.1-flash' } },
      executor: { model: { provider: 'magpie', model: 'deepseek-v4.1-flash' } } }) },
    context: { sessionController: { modelCatalog: async () => ({
      default: { provider: 'magpie', model: 'deepseek-v4.1-flash' },
      groups: [{ id: 'magpie', name: 'Magpie', models: [{ id: 'deepseek-v4.1-flash' }] }], failures: [],
    }) } },
    magpie: async () => magpie,
    codexQuota: async () => codex,
  } as never, 'models', 0, undefined) as Record<string, any>

  expect(result.magpie).toEqual(magpie)
  expect(result.codex_quota).toEqual(codex)
  expect(result.routing).toMatchObject({ source: 'magpie' })
  expect(result.codex_routing).toMatchObject({
    source: 'codex', status: 'available', availability: 'available', ordinary_usage_allowed: true,
    primary: { used_percent: 30, remaining_percent: 70 },
  })
  expect(summarizeCodexQuotaSignals({ status: 'unknown', error: 'read-failed' })).toMatchObject({
    source: 'codex', status: 'unknown', availability: 'unknown', error: 'read-failed',
  })
})
