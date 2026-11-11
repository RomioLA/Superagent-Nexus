/** Read-only Magpie gateway telemetry scoped to the DSH Router and Worker keys. */
import { createHmac } from 'node:crypto'

export const DEFAULT_MAGPIE_GATEWAY_BASE_URL = 'http://172.28.128.1:3425/v1'
export const MAGPIE_REFRESH_INTERVAL_MS = 60_000
export type MagpieEndpointState = 'ok' | 'not-configured' | 'unauthorized' | 'forbidden' | 'connection-failed'
  | 'version-unsupported' | 'invalid-response' | 'no-data' | 'rate-limited' | 'http-error'
type Json = Record<string, unknown>
type EndpointResult = { state: MagpieEndpointState; data?: unknown }
type CallerRole = 'router' | 'worker'
type KeyConfig = { role: CallerRole; secret?: string }
export interface MagpieReaderOptions {
  baseUrl?: string; routerKey?: string; workerKey?: string; fetcher?: typeof fetch
  now?: () => Date; cacheMs?: number; timeoutMs?: number
}
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const stringValue = (value: unknown): string | null => typeof value === 'string' && value.length ? value : null
const identifier = (value: unknown): string | null => typeof value === 'string' || typeof value === 'number' ? String(value) : null
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const endpointBody = (value: unknown): unknown => isRecord(value) && (isRecord(value.data) || Array.isArray(value.data)) ? value.data : value
const arrayAt = (value: unknown, keys: readonly string[]): unknown[] | null => {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return null
  for (const key of keys) if (Array.isArray(value[key])) return value[key] as unknown[]
  return null
}
const httpState = (status: number): MagpieEndpointState => status === 401 ? 'unauthorized'
  : status === 403 ? 'forbidden' : status === 404 || status === 405 || status === 501 ? 'version-unsupported'
    : status === 429 ? 'rate-limited' : 'http-error'
function exactCallerId(limit: unknown, usage: unknown): { id: string | null; state: 'matched' | 'missing' | 'ambiguous' } {
  const label = isRecord(limit) ? stringValue(limit.key) : null
  const callers = arrayAt(usage, ['callerKeys'])
  if (!label || !callers) return { id: null, state: 'missing' }
  const ids = new Set(callers.flatMap(item => {
    if (!isRecord(item)) return []
    const name = stringValue(item.callerKeyName) ?? stringValue(item.name)
    const id = identifier(item.callerKeyId) ?? identifier(item.id)
    return name === label && id ? [id] : []
  }))
  if (ids.size === 1) return { id: [...ids][0]!, state: 'matched' }
  return { id: null, state: ids.size ? 'ambiguous' : 'missing' }
}
function quotaCards(value: unknown): unknown[] | null {
  const direct = arrayAt(value, ['quotas', 'cards', 'accounts', 'items'])
  if (direct) return direct
  if (!isRecord(value) || !Array.isArray(value.providers)) return null
  const result: Json[] = []
  for (const provider of value.providers) {
    if (!isRecord(provider) || !Array.isArray(provider.accounts)) continue
    for (const account of provider.accounts) if (isRecord(account))
      result.push({ ...account, provider: account.provider ?? provider.id ?? provider.provider })
  }
  return result.length ? result : null
}
const accountKey = (provider: string, account: string): string => provider + '\u0000' + account
const accountRef = (provider: string, account: string, salt: string): string =>
  createHmac('sha256', salt).update(accountKey(provider, account)).digest('hex').slice(0, 16)
function windowView(value: unknown) {
  if (!isRecord(value)) return null
  const remaining = finite(value.remaining)
  return {
    unit: stringValue(value.unit), limit: finite(value.limit), used: finite(value.used), remaining,
    availability: remaining === null ? 'unknown' : remaining > 0 ? 'remaining' : 'exhausted',
    resets_at: stringValue(value.resetsAt), runs_out_at: stringValue(value.runsOutAt),
  }
}
function metric(rows: readonly Json[], field: string) {
  let sum = 0, reported = 0
  for (const row of rows) {
    const value = finite(row[field])
    if (value !== null && value >= 0) { sum += value; reported++ }
  }
  return { value: reported === rows.length ? sum : null, reported_requests: reported, missing_requests: rows.length - reported }
}
function failed(row: Json): boolean {
  const status = finite(row.status)
  return row.failed === true || stringValue(row.err) !== null || (status !== null && status >= 400)
}
async function fetchJson(baseUrl: string, path: string, key: string, fetcher: typeof fetch, timeoutMs: number,
  params?: URLSearchParams): Promise<EndpointResult> {
  let url: URL
  try {
    const base = new URL(baseUrl)
    if ((base.protocol !== 'http:' && base.protocol !== 'https:') || base.username || base.password) return { state: 'invalid-response' }
    url = new URL(path, base.href.endsWith('/') ? base.href : base.href + '/')
    if (params) url.search = params.toString()
  } catch { return { state: 'invalid-response' } }
  try {
    const response = await fetcher(url, {
      method: 'GET', headers: { accept: 'application/json', authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { state: httpState(response.status) }
    let parsed: unknown
    try { parsed = await response.json() } catch { return { state: 'invalid-response' } }
    const data = endpointBody(parsed)
    if (!isRecord(data) && !Array.isArray(data)) return { state: 'invalid-response' }
    return { state: 'ok', data }
  } catch { return { state: 'connection-failed' } }
}
async function keyInfo(baseUrl: string, config: KeyConfig, fetcher: typeof fetch, timeoutMs: number) {
  if (!config.secret) return {
    role: config.role, limitState: 'not-configured' as MagpieEndpointState, usageState: 'not-configured' as MagpieEndpointState,
    matchState: 'missing' as const, callerId: null, currentlyLimited: null,
  }
  const [limitResult, usageResult] = await Promise.all([
    fetchJson(baseUrl, 'magpie/limit', config.secret, fetcher, timeoutMs),
    fetchJson(baseUrl, 'magpie/usage', config.secret, fetcher, timeoutMs, new URLSearchParams({ period: 'today' })),
  ])
  const limit = limitResult.state === 'ok' ? limitResult.data : undefined
  const usage = usageResult.state === 'ok' ? usageResult.data : undefined
  const caller = limit && usage ? exactCallerId(limit, usage) : { id: null, state: 'missing' as const }
  const limited = isRecord(limit) && typeof limit.limited === 'boolean' ? limit.limited : null
  return { role: config.role, limitState: limitResult.state, usageState: usageResult.state,
    matchState: caller.state, callerId: caller.id, currentlyLimited: limited }
}
function requestRows(value: unknown): unknown[] | null { return arrayAt(value, ['requests', 'items', 'rows']) }
async function readRequests(baseUrl: string, secret: string, callerId: string, fetcher: typeof fetch, timeoutMs: number) {
  const rows: Json[] = []
  let state: MagpieEndpointState = 'ok', unmatchedRows = 0, complete = true
  const pageSize = 500, maxPages = 20
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ period: 'today', callerKey: callerId, offset: String(page * pageSize), limit: String(pageSize) })
    const result = await fetchJson(baseUrl, 'magpie/usage/requests', secret, fetcher, timeoutMs, params)
    if (result.state !== 'ok') { state = result.state; complete = false; break }
    const batch = requestRows(result.data)
    if (!batch) { state = 'invalid-response'; complete = false; break }
    for (const raw of batch) {
      if (!isRecord(raw)) { unmatchedRows++; continue }
      const rowCallerId = identifier(raw.callerKeyId) ?? identifier(raw.caller_key_id)
      if (rowCallerId !== callerId) { unmatchedRows++; continue }
      rows.push(raw)
    }
    if (batch.length < pageSize) break
    if (page === maxPages - 1) complete = false
  }
  if (!rows.length && state === 'ok') state = 'no-data'
  return { state, rows, unmatchedRows, complete }
}
function summarizeRoutes(rows: readonly { roles: readonly CallerRole[]; row: Json }[], matchedQuotaKeys: ReadonlySet<string>, accountSalt: string) {
  const groups = new Map<string, { rows: Json[]; roles: Set<CallerRole>; provider: string | null; requested: string | null; served: string | null; account: string | null }>()
  for (const item of rows) {
    const row = item.row, provider = stringValue(row.provider), requested = stringValue(row.req)
    const served = stringValue(row.served) ?? stringValue(row.model), rawAccount = stringValue(row.providerAccount)
    const linked = !!provider && !!rawAccount && matchedQuotaKeys.has(accountKey(provider, rawAccount))
    const ref = linked ? accountRef(provider!, rawAccount!, accountSalt) : null
    const key = JSON.stringify([provider, requested, served, ref])
    let group = groups.get(key)
    if (!group) groups.set(key, group = { rows: [], roles: new Set(), provider, requested, served, account: ref })
    group.rows.push(row)
    for (const role of item.roles) group.roles.add(role)
  }
  return [...groups.values()].map(group => {
    const values = group.rows
    const priced = values.filter(row => row.priced === true && finite(row.cost) !== null && finite(row.cost)! >= 0)
    const costKnown = values.length > 0 && priced.length === values.length
    return {
      provider: group.provider, requested_model: group.requested, served_model: group.served,
      account_ref: group.account, account_status: group.account ? 'linked_to_quota_snapshot' : 'unknown_or_unmatched',
      callers: [...group.roles].sort(), requests: values.length, failures: values.filter(failed).length,
      input_tokens: metric(values, 'in'), output_tokens: metric(values, 'out'), reasoning_tokens: metric(values, 'reasoning'),
      cache_read_tokens: metric(values, 'cache_read'), cache_write_tokens: metric(values, 'cache_write'),
      priced_requests: priced.length, unpriced_requests: values.length - priced.length,
      cost_usd: costKnown ? priced.reduce((sum, row) => sum + finite(row.cost)!, 0) : null,
      cost_status: costKnown ? 'known' : values.length ? 'unknown_unpriced' : 'no_data',
      cache_hit_rate: null, cache_hit_rate_status: 'unknown_no_reliable_denominator',
    }
  })
}
async function loadSnapshot(options: Required<Pick<MagpieReaderOptions, 'baseUrl' | 'fetcher' | 'now' | 'timeoutMs'>> & {
  routerKey?: string; workerKey?: string
}) {
  const checkedAt = options.now().toISOString()
  const keys: KeyConfig[] = [{ role: 'router', secret: options.routerKey }, { role: 'worker', secret: options.workerKey }]
  const configured = keys.filter(item => !!item.secret)
  const empty = (state: 'not-configured' | 'unavailable') => ({
    status: state, checked_at: checkedAt, period: 'today', local_cache_ttl_ms: MAGPIE_REFRESH_INTERVAL_MS,
    endpoint_status: { quotas: 'not-configured' as MagpieEndpointState, router: null, worker: null },
    keys: [], account_quotas: [], request_usage: [], cache_hit_rate: null,
    cache_hit_rate_status: 'unknown_no_reliable_denominator', cost_routing: 'unknown_no_verified_usd_cost_or_budget_boundary',
  })
  if (!configured.length) return empty('not-configured')

  const [keyInfos, quotaResult] = await Promise.all([
    Promise.all(keys.map(item => keyInfo(options.baseUrl, item, options.fetcher, options.timeoutMs))),
    fetchJson(options.baseUrl, 'magpie/quotas', configured[0]!.secret!, options.fetcher, options.timeoutMs,
      new URLSearchParams({ kept: '1' })),
  ])
  const uniqueKeys = new Map<string, { callerId: string; secret: string; roles: Set<CallerRole> }>()
  for (const info of keyInfos) {
    const secret = keys.find(item => item.role === info.role)?.secret
    if (info.callerId && secret) {
      const existing = uniqueKeys.get(info.callerId)
      if (existing) existing.roles.add(info.role)
      else uniqueKeys.set(info.callerId, { callerId: info.callerId, secret, roles: new Set([info.role]) })
    }
  }
  const requestResults = await Promise.all([...uniqueKeys.values()].map(async item => ({
    item, result: await readRequests(options.baseUrl, item.secret, item.callerId, options.fetcher, options.timeoutMs),
  })))
  const observedRows: { roles: CallerRole[]; row: Json }[] = []
  const keyRequestState = new Map<string, MagpieEndpointState>()
  let truncated = false, unmatchedRows = 0
  for (const { item, result } of requestResults) {
    keyRequestState.set(item.callerId, result.state)
    truncated ||= !result.complete
    unmatchedRows += result.unmatchedRows
    for (const row of result.rows) observedRows.push({ roles: [...item.roles], row })
  }
  const quotaRows = quotaResult.state === 'ok' ? quotaCards(quotaResult.data) : null
  const quotaState: MagpieEndpointState = quotaResult.state === 'ok' && !quotaRows ? 'invalid-response' : quotaResult.state
  const observedAccounts = new Map<string, { provider: string; account: string }>()
  for (const { row } of observedRows) {
    const provider = stringValue(row.provider), account = stringValue(row.providerAccount)
    if (provider && account) observedAccounts.set(accountKey(provider, account), { provider, account })
  }
  const matchedQuotaKeys = new Set<string>(), accountQuotas: Json[] = []
  for (const [key, observed] of observedAccounts) {
    const matches = (quotaRows ?? []).filter(card =>
      isRecord(card) && stringValue(card.provider) === observed.provider && stringValue(card.user) === observed.account)
    const exact = matches.length === 1 ? matches[0] : undefined
    if (exact && isRecord(exact)) matchedQuotaKeys.add(key)
    const windows = exact && isRecord(exact) && Array.isArray(exact.windows) ? exact.windows.map(windowView).filter(Boolean) : []
    accountQuotas.push({
      provider: observed.provider, account_ref: accountRef(observed.provider, observed.account, configured[0]!.secret!),
      state: quotaState !== 'ok' ? quotaState : matches.length === 1 ? 'ok' : matches.length ? 'ambiguous' : 'no-data',
      read_at: exact && isRecord(exact) ? stringValue(exact.readAt) : null, windows,
    })
  }
  const requestStatus = (info: typeof keyInfos[number]): MagpieEndpointState | 'not-queried' | 'ambiguous' =>
    info.callerId ? keyRequestState.get(info.callerId) ?? 'no-data'
      : info.usageState !== 'ok' ? info.usageState : info.matchState === 'ambiguous' ? 'ambiguous' : 'not-queried'
  const keysView = keyInfos.map(info => ({
    caller: info.role, limit_status: info.limitState, currently_limited: info.currentlyLimited,
    cost_boundary_usd: null, cost_boundary_status: 'unknown',
    caller_attribution_status: info.usageState !== 'ok' ? info.usageState : info.matchState,
    request_status: requestStatus(info),
  }))
  const completeKeys = configured.every(config => {
    const info = keyInfos.find(item => item.role === config.role)
    const requests = info?.callerId ? keyRequestState.get(info.callerId) : undefined
    return info?.limitState === 'ok' && info.usageState === 'ok' && !!info.callerId && (requests === 'ok' || requests === 'no-data')
  })
  const haveAnyData = keyInfos.some(info => info.limitState === 'ok' || info.usageState === 'ok') || quotaState === 'ok' || observedRows.length > 0
  const status = completeKeys && quotaState === 'ok' && !truncated && !unmatchedRows ? 'available' : haveAnyData ? 'partial' : 'unavailable'
  return {
    status, checked_at: checkedAt, period: 'today', local_cache_ttl_ms: MAGPIE_REFRESH_INTERVAL_MS,
    endpoint_status: {
      quotas: quotaState,
      router: requestStatus(keyInfos[0]!),
      worker: requestStatus(keyInfos[1]!),
    },
    keys: keysView, account_quotas: accountQuotas, request_usage: summarizeRoutes(observedRows, matchedQuotaKeys, configured[0]!.secret!),
    cache_hit_rate: null, cache_hit_rate_status: 'unknown_no_reliable_denominator',
    cost_routing: 'unknown_no_verified_usd_cost_or_budget_boundary',
    ...(unmatchedRows ? { unattributed_request_rows: unmatchedRows } : {}),
    ...(truncated ? { request_history_truncated: true } : {}),
  }
}

/** Return a cached, secret-redacted summary of the available Magpie data. This reader only issues GET requests. */
export function createMagpieReader(options: MagpieReaderOptions = {}): () => Promise<unknown> {
  const settings = {
    baseUrl: options.baseUrl ?? process.env.MAGPIE_GATEWAY_BASE_URL ?? DEFAULT_MAGPIE_GATEWAY_BASE_URL,
    fetcher: options.fetcher ?? globalThis.fetch, now: options.now ?? (() => new Date()),
    timeoutMs: options.timeoutMs ?? 5000, cacheMs: options.cacheMs ?? MAGPIE_REFRESH_INTERVAL_MS,
  }
  let cached: { value: unknown; until: number } | undefined, inFlight: Promise<unknown> | undefined
  return async () => {
    const now = settings.now().getTime()
    if (cached && now < cached.until) return cached.value
    if (inFlight) return inFlight
    inFlight = loadSnapshot({
      baseUrl: settings.baseUrl, fetcher: settings.fetcher, now: settings.now, timeoutMs: settings.timeoutMs,
      routerKey: options.routerKey ?? process.env.MAGPIE_ROUTER_KEY, workerKey: options.workerKey ?? process.env.MAGPIE_WORKER_KEY,
    }).then(value => {
      cached = { value, until: settings.now().getTime() + settings.cacheMs }
      return value
    }).finally(() => { inFlight = undefined })
    return inFlight
  }
}
