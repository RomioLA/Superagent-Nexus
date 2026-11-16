/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList, ticketStatusCountsOf } from './views/tickets.ts'
import { summarizeCodexQuotaSignals, summarizeHarnessAvailability, summarizeRoutingSignals, diffModelSurface, discoverModelSurface, type AvailabilityReading, type ModelSurfaceSnapshot, type HarnessModelSource } from './routing.ts'
import { discoverTools, isRouteAuthorized, readSelection, saveSelection, selectionView } from './models.ts'
import { KV } from '../kv.ts'

export interface HttpHost {
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
  /** Read-only Magpie telemetry for the routing view, shared with the main Session's model resource. */
  readonly magpie?: () => Promise<unknown>
  /** Read-only Codex account quota, read only on an explicit panel scan (it spawns the Codex CLI). */
  readonly codexQuota?: () => Promise<unknown>
  /** Real per-Harness model lists (Codex/Grok caches, AGY CLI) read only on an explicit panel scan. */
  readonly harnessModels?: () => Promise<HarnessModelSource[]>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    status: ticketStatusCountsOf(runtime.store),
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
const statusOf = (value: unknown): string => {
  const status = value && typeof value === 'object' ? (value as { status?: unknown }).status : undefined
  return typeof status === 'string' ? status : 'unknown'
}
/** The four supported Harnesses as panel rows: a real reading where a reader exists, an explicit unknown otherwise. */
function harnessRows(input: { magpie?: unknown; codex?: AvailabilityReading; codexSource?: string; tools?: readonly { name: string; installed: boolean }[] }) {
  const live = summarizeHarnessAvailability({ magpie: input.magpie })
  const installed = new Map(input.tools?.map(tool => [tool.name, tool.installed]) ?? [])
  const rows = [
    { harness: 'dsh', reading: live.dsh, source: 'magpie' },
    { harness: 'codex', reading: input.codex ?? live.codex, source: input.codex ? (input.codexSource ?? 'codex') : 'unknown' },
    { harness: 'grok', reading: live.grok, source: 'unknown' },
    { harness: 'agy', reading: live.agy, source: 'unknown' },
  ]
  return rows.map(({ harness, reading, source }) => ({ harness, state: reading.state,
    // DSH is the built-in Harness; the others are only executable when their executor CLI was actually found.
    installed: harness === 'dsh' ? true : installed.get(harness) ?? false,
    ...(reading.evidence ? { evidence: reading.evidence } : {}), ...(reading.remaining !== undefined ? { remaining: reading.remaining } : {}),
    ...(reading.resetsAt ? { resets_at: reading.resetsAt } : {}), source }))
}
/**
 * The panel's model-routing view: the live model catalog, configured role models, the explainable Magpie logical channels
 * (deduplicated per model, with the user's authorization flag), the four Harnesses' real availability where readable, and an
 * honest quality statement. It reads the same resource readers and `routing.ts` rules the main Session's `models` resource uses.
 */
export async function routingView(runtime: HttpHost) {
  const catalog = await runtime.models()
  const settings = runtime.store.settings()
  const magpie = runtime.magpie ? await runtime.magpie() : { status: 'not-configured' }
  const routing = summarizeRoutingSignals(magpie)
  const scan = runtime.store.get(KV.models.scan)
  const harnessModels = (scan?.harnessModels as HarnessModelSource[] | undefined) ?? []
  const surface = discoverModelSurface(catalog, routing, settings.executor.model, harnessModels)
  const tools = discoverTools()
  const selection = readSelection(runtime.store)
  // Codex's real quota is read only on an explicit scan; the panel poll keeps it unknown rather than spawning the CLI each time.
  const codex = summarizeCodexQuotaSignals({ status: 'unknown' })
  const qualityReviews = runtime.store.tickets.list()
    .flatMap(ticket => (ticket.execution?.qualityReviews ?? []).map(review => ({ ticket_id: ticket.id, ...review })))
  return {
    checked_at: routing.checked_at, status: routing.status,
    roles: { orchestrator: settings.eval.model, worker: settings.executor.model },
    providers: catalog.groups.map(group => ({ id: group.id, name: group.name, count: group.models.length })),
    channels: surface.channels.map(channel => ({ ...channel, authorized: isRouteAuthorized(selection, channel.harness, channel.model) })),
    discovered: surface.discovered,
    preferred: routing.preferred_channel, unknown: routing.unknown, note: routing.note,
    harnesses: harnessRows({ magpie, codex: scan?.harnesses.codex as unknown as AvailabilityReading | undefined,
      codexSource: scan ? `codex (scan ${scan.fetchedAt})` : undefined, tools }),
    authorization: selectionView(runtime.store),
    scan: scan ? { fetched_at: scan.fetchedAt } : null,
    codex,
    quality: qualityReviews.length
      ? { evidence: 'recorded' as const, samples: qualityReviews.length, reviews: qualityReviews,
        note: 'Quality evidence is recorded per Ticket; only comparable calibrated reviews are evidence-backed, otherwise provisional. Ranking uses orchestrator_rank_candidates.' }
      : { evidence: 'insufficient' as const, samples: 0, reviews: [],
        note: 'No comparable quality-evaluation samples are recorded; model quality cannot be ranked here.' },
  }
}
export type RoutingView = Awaited<ReturnType<typeof routingView>>
/**
 * A manual model scan: reads the catalog, Magpie and Codex quota once, reports what changed since the previous scan, and
 * stores the new baseline and the real per-Harness readings. It never adds a route to the authorization set.
 */
export async function scanView(runtime: HttpHost) {
  const catalog = await runtime.models()
  const magpie = runtime.magpie ? await runtime.magpie() : { status: 'not-configured' }
  const codexRaw = runtime.codexQuota ? await runtime.codexQuota() : { status: 'unknown', error: 'reader-not-configured' }
  const routing = summarizeRoutingSignals(magpie)
  const settings = typeof runtime.store.settings === 'function' ? runtime.store.settings() : undefined
  const harnessModels = runtime.harnessModels ? await runtime.harnessModels() : []
  const surface = discoverModelSurface(catalog, routing, settings?.executor?.model, harnessModels)
  const identity = (item: { harness: string; provider: string; model: string }): string => `${item.harness}:${item.provider}:${item.model}`
  const snapshot: ModelSurfaceSnapshot = {
    catalog: surface.discovered.map(identity),
    availability: Object.fromEntries(surface.discovered.map(item => [identity(item), item.availability])),
    sources: { catalog: catalog.failures.length ? 'failed' : 'ok', magpie: statusOf(magpie), codex: statusOf(codexRaw),
      ...Object.fromEntries(harnessModels.map(source => [`${source.harness}-models`, source.status])) },
  }
  const previous = runtime.store.get(KV.models.scan)
  const prior = previous ? previous.snapshot as unknown as ModelSurfaceSnapshot : undefined
  // Older scans keyed DSH models as `provider/model`; map them to the current identity so the first scan is not noisy.
  const priorCatalog = (prior?.catalog ?? []).map(id => id.includes(':') || !id.includes('/')
    ? id : `dsh:${id.slice(0, id.indexOf('/'))}:${id.slice(id.indexOf('/') + 1)}`)
  const comparable = prior ? { ...prior, catalog: priorCatalog } : undefined
  // A source that could not be read is unknown, not empty: keep its last-seen models so a scan does not report them removed.
  const failedHarnesses = harnessModels.filter(source => source.status === 'failed').map(source => source.harness)
  if (failedHarnesses.length) {
    const kept = priorCatalog.filter(id => failedHarnesses.some(harness => id.startsWith(`${harness}:`)) && !snapshot.catalog.includes(id))
    snapshot.catalog.push(...kept)
  }
  const diff = diffModelSurface(comparable, snapshot)
  const harnesses = summarizeHarnessAvailability({ magpie, codex: codexRaw })
  const fetchedAt = new Date().toISOString()
  const providers = catalog.groups.map(group => ({ id: group.id, name: group.name, count: group.models.length }))
  const tools = discoverTools()
  runtime.store.set(KV.models.scan, { fetchedAt, providers, harnesses, snapshot, harnessModels })
  const selection = readSelection(runtime.store)
  return { fetched_at: fetchedAt, first: previous === undefined, diff, providers,
    harnesses: harnessRows({ magpie, codex: harnesses.codex, codexSource: 'codex', tools }),
    tools,
    harness_models: harnessModels,
    channels: surface.channels.map(channel => ({ ...channel, authorized: isRouteAuthorized(selection, channel.harness, channel.model) })),
    discovered: surface.discovered }
}
export type ScanView = Awaited<ReturnType<typeof scanView>>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET models/routing': () => routingView(runtime),
    'POST models/scan': () => scanView(runtime),
    'PUT models/selection': async ({ body }) => {
      const request = z.object({ enabled: z.array(z.string().min(1).max(200)).max(500) }).parse(await body())
      saveSelection(runtime.store, request.enabled)
      return selectionView(runtime.store)
    },
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
