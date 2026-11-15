import { expect, it } from 'vitest'
import { createMagpieReader } from '../src/app/magpie.ts'
import { readResource } from '../src/app/resources.ts'

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const testFetch = (handle: (url: URL, authorization: string) => Response | Promise<Response>): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => handle(new URL(String(input)), new Headers(init?.headers).get('authorization') ?? '')) as typeof fetch
const keyName = (authorization: string) => authorization === 'Bearer router-secret' ? 'Router Key' : 'Worker Key'
const caller = (authorization: string) => authorization === 'Bearer router-secret'
  ? { callerKeyId: 'router-id', callerKeyName: 'Router Key', name: 'Router Key' }
  : { callerKeyId: 'worker-id', callerKeyName: 'Worker Key', name: 'Worker Key' }

it('adds scoped quota, request and cache telemetry to the existing models resource without inventing price or hit rate', async () => {
  const calls: { path: string; query: string; method: string }[] = []
  const fetcher = testFetch((url, authorization) => {
    calls.push({ path: url.pathname, query: url.search, method: 'GET' })
    const name = keyName(authorization)
    if (url.pathname.endsWith('/magpie/limit')) return response({ key: name, limited: false })
    if (url.pathname.endsWith('/magpie/usage') && !url.pathname.endsWith('/requests'))
      return response({ callerKeys: [caller(authorization)] })
    if (url.pathname.endsWith('/magpie/usage/requests')) {
      const id = url.searchParams.get('callerKey')
      const row = id === 'router-id'
        ? { callerKeyId: id, provider: 'deepseek', providerAccount: 'account-a', req: 'auto/deepseek-v4.1-flash',
            served: 'deepseek-v4.1-flash', in: 40, out: 10, reasoning: 2, cache_read: 1000, cache_write: 0,
            priced: false, cost: 0, status: 200, rid: 'router-req' }
        : { callerKeyId: id, provider: 'deepseek', providerAccount: 'account-a', req: 'deepseek-v4.1-flash',
            served: 'deepseek-v4.1-flash', in: 60, out: 20, reasoning: 0, cache_read: 3000, cache_write: 5,
            priced: false, cost: 0, status: 200, rid: 'worker-req' }
      return response({ requests: [row] })
    }
    if (url.pathname.endsWith('/magpie/quotas')) return response({ data: [{ provider: 'deepseek', user: 'account-a', readAt: '2026-11-11T13:59:00Z',
      windows: [{ unit: 'day', limit: 1000, used: 1000, remaining: 0, resetsAt: '2026-11-12T00:00:00Z', runsOutAt: null }] }] })
    throw new Error('unexpected Magpie endpoint')
  })
  const read = createMagpieReader({
    baseUrl: 'http://magpie.test/v1', routerKey: 'router-secret', workerKey: 'worker-secret', fetcher,
    now: () => new Date('2026-11-11T14:00:00Z'),
  })
  const first = await read() as Record<string, any>
  const callsAfterFirst = calls.length
  const second = await read() as Record<string, any>

  expect(first).toMatchObject({
    status: 'available',
    endpoint_status: { quotas: 'ok', router: 'ok', worker: 'ok' },
    keys: [
      { caller: 'router', currently_limited: false, cost_boundary_usd: null, cost_boundary_status: 'unknown' },
      { caller: 'worker', currently_limited: false, cost_boundary_usd: null, cost_boundary_status: 'unknown' },
    ],
    account_quotas: [{ provider: 'deepseek', state: 'ok', read_at: '2026-11-11T13:59:00Z',
      windows: [{ unit: 'day', limit: 1000, used: 1000, remaining: 0, availability: 'exhausted', resets_at: '2026-11-12T00:00:00Z' }] }],
    cache_hit_rate: null,
    cache_hit_rate_status: 'unknown_no_reliable_denominator',
  })
  expect(first.request_usage).toHaveLength(2)
  expect(first.request_usage[0]).toMatchObject({
    provider: 'deepseek', served_model: 'deepseek-v4.1-flash', account_status: 'linked_to_quota_snapshot',
    requests: 1, input_tokens: { value: 40 }, cache_read_tokens: { value: 1000 },
    priced_requests: 0, unpriced_requests: 1, cost_usd: null, cost_status: 'unknown_unpriced',
    cache_hit_rate: null,
  })
  expect(first.request_usage[1]).toMatchObject({
    callers: ['worker'], requests: 1, input_tokens: { value: 60 }, cache_read_tokens: { value: 3000 },
  })
  expect(JSON.stringify(first)).not.toContain('router-secret')
  expect(JSON.stringify(first)).not.toContain('worker-secret')
  expect(JSON.stringify(first)).not.toContain('account-a')
  expect(second).toEqual(first)
  expect(calls).toHaveLength(callsAfterFirst)
  expect(calls.every(item => item.method === 'GET')).toBe(true)
  expect(calls.filter(item => item.path.endsWith('/magpie/usage/requests')).every(item => item.query.includes('callerKey='))).toBe(true)
})

it('does not query unscoped request history when key attribution is missing or ambiguous', async () => {
  let requestCalls = 0
  const fetcher = testFetch(url => {
    if (url.pathname.endsWith('/magpie/limit')) return response({ key: 'Router Key', limited: false })
    if (url.pathname.endsWith('/magpie/usage') && !url.pathname.endsWith('/requests'))
      return response({ callerKeys: [{ callerKeyId: 'different-id', callerKeyName: 'Other Key' }] })
    if (url.pathname.endsWith('/magpie/usage/requests')) { requestCalls++; return response({ requests: [] }) }
    if (url.pathname.endsWith('/magpie/quotas')) return response([])
    throw new Error('unexpected Magpie endpoint')
  })
  const result = await createMagpieReader({
    baseUrl: 'http://magpie.test/v1', routerKey: 'router-secret', fetcher,
  })() as Record<string, any>
  expect(result.keys[0]).toMatchObject({ caller_attribution_status: 'missing', request_status: 'not-queried' })
  expect(result.endpoint_status.router).toBe('not-queried')
  expect(requestCalls).toBe(0)
  expect(result.request_usage).toEqual([])
})

it('distinguishes authentication, permission, unsupported-version and connection failures', async () => {
  const cases: [number | 'connection', string][] = [
    [401, 'unauthorized'], [403, 'forbidden'], [404, 'version-unsupported'], [503, 'http-error'], ['connection', 'connection-failed'],
  ]
  for (const [status, expected] of cases) {
    const fetcher = testFetch(() => {
      if (status === 'connection') throw new Error('network unavailable')
      return response({}, status)
    })
    const result = await createMagpieReader({
      baseUrl: 'http://magpie.test/v1', routerKey: 'router-secret', fetcher,
    })() as Record<string, any>
    expect(result.keys[0].limit_status).toBe(expected)
    expect(result.endpoint_status.quotas).toBe(expected)
  }
})

it('serves the live Magpie snapshot alongside native defaults, role models and provider catalog', async () => {
  const snapshot = { status: 'partial', cost_routing: 'unknown_no_verified_usd_cost_or_budget_boundary' }
  const result = await readResource({
    masterId: 'main',
    settings: {},
    store: { tickets: { list: () => [] }, settings: () => ({ eval: { model: { provider: 'magpie', model: 'deepseek-v4.1-flash' } },
      executor: { model: { provider: 'magpie', model: 'deepseek-v4.1-flash' } } }) },
    context: { sessionController: { modelCatalog: async () => ({
      default: { provider: 'magpie', model: 'deepseek-v4.1-flash' },
      groups: [{ id: 'magpie', name: 'Magpie', models: [{ id: 'deepseek-v4.1-flash' }] }], failures: [],
    }) } },
    magpie: async () => snapshot,
  } as never, 'models', 0, undefined) as Record<string, any>
  expect(result).toMatchObject({
    default: { provider: 'magpie', model: 'deepseek-v4.1-flash' },
    roles: { orchestrator: { provider: 'magpie' }, worker: { provider: 'magpie' } },
    providers: [{ id: 'magpie', read: 'models/magpie' }],
    magpie: snapshot,
  })
})

it('reports an empty filtered request page as actual no data, not an unavailable endpoint', async () => {
  const fetcher = testFetch((url, authorization) => {
    if (url.pathname.endsWith('/magpie/limit')) return response({ key: 'Router Key', limited: false })
    if (url.pathname.endsWith('/magpie/usage') && !url.pathname.endsWith('/requests'))
      return response({ callerKeys: [{ callerKeyId: 'router-id', callerKeyName: 'Router Key' }] })
    if (url.pathname.endsWith('/magpie/usage/requests')) return response({ requests: [] })
    if (url.pathname.endsWith('/magpie/quotas')) return response({ data: [] })
    throw new Error('unexpected Magpie endpoint')
  })
  const result = await createMagpieReader({
    baseUrl: 'http://magpie.test/v1', routerKey: 'router-secret', fetcher,
  })() as Record<string, any>
  expect(result).toMatchObject({
    status: 'available',
    endpoint_status: { quotas: 'ok', router: 'no-data', worker: 'not-configured' },
    keys: [
      { caller_attribution_status: 'matched', request_status: 'no-data' },
      { caller_attribution_status: 'not-configured', request_status: 'not-configured' },
    ],
    request_usage: [],
  })
})
