import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { routingView, scanView } from '../src/app/http.ts'
import { discoverTools, isRouteAuthorized, readSelection, routeKey, saveSelection, selectionView } from '../src/app/models.ts'
import { codexCliPath } from '../src/app/tools/cli-isolation.ts'

/** Minimal KV-shaped fake so the authorization helpers can be tested without a full SQLite store. */
function fakeStore(executorModel: { provider: string; model: string } | null = null) {
  const map = new Map<string, unknown>()
  const settings = { executor: { model: executorModel }, eval: { model: null } }
  return { get: (key: string) => map.get(key), set: (key: string, value: unknown) => { map.set(key, value) }, settings: () => settings,
    tickets: { list: () => [] } }
}

it('authorizes every route until the user saves an explicit set', () => {
  const store = fakeStore()
  expect(readSelection(store as never)).toBeUndefined()
  expect(selectionView(store as never)).toEqual({ explicit: false, enabled: null })
  expect(isRouteAuthorized(undefined, 'dsh', 'm1')).toBe(true)
  expect(isRouteAuthorized(undefined, 'grok')).toBe(true)
})

it('restricts dispatch to the exact enabled logical routes once a set is saved', () => {
  const store = fakeStore()
  saveSelection(store as never, ['dsh/m1', 'codex', 'dsh/m1'])
  const selection = readSelection(store as never)
  expect([...selection!].sort()).toEqual(['codex', 'dsh/m1'])
  expect(isRouteAuthorized(selection, 'dsh', 'm1')).toBe(true)
  expect(isRouteAuthorized(selection, 'dsh', 'm2')).toBe(false)
  // A whole-Harness key authorizes any model of that Harness.
  expect(isRouteAuthorized(selection, 'codex', 'gpt-6-luna')).toBe(true)
  expect(isRouteAuthorized(selection, 'grok')).toBe(false)
  expect(selectionView(store as never)).toEqual({ explicit: true, enabled: ['codex', 'dsh/m1'] })
})

it('builds route keys and treats an empty saved set as authorizing nothing', () => {
  const store = fakeStore()
  saveSelection(store as never, [])
  const selection = readSelection(store as never)
  expect(routeKey('dsh', 'm1')).toBe('dsh/m1')
  expect(routeKey('grok')).toBe('grok')
  expect(isRouteAuthorized(selection, 'dsh', 'm1')).toBe(false)
  expect(isRouteAuthorized(selection, 'grok')).toBe(false)
})

it('normalizes a provider-qualified role model to the served logical id so a checked box matches real dispatch', () => {
  const store = fakeStore()
  // The panel writes the observed (bare) served model; dispatch carries the provider-qualified role model.
  saveSelection(store as never, ['dsh/deepseek-v4.1-flash'])
  const selection = readSelection(store as never)
  expect(routeKey('dsh', 'auto/deepseek-v4.1-flash')).toBe('dsh/deepseek-v4.1-flash')
  expect(isRouteAuthorized(selection, 'dsh', 'auto/deepseek-v4.1-flash')).toBe(true)
  expect(isRouteAuthorized(selection, 'dsh', 'deepseek-v4.1-flash')).toBe(true)
})

it('reports detected tools without ever promoting an unsupported interface (Cursor) to callable', () => {
  const tools = discoverTools('/nonexistent-dsh-tool-path')
  expect(tools.map(tool => tool.name)).toEqual(['grok', 'codex', 'agy', 'cursor'])
  for (const tool of tools) expect(tool.status === 'not-installed').toBe(!tool.installed)
  const cursor = tools.find(tool => tool.name === 'cursor')!
  expect(cursor.status).not.toBe('supported')
  expect(cursor.callable).toBe('no')
})

it.skipIf(!existsSync(codexCliPath()))('detects the Codex CLI the executor and quota reader resolve outside PATH', () => {
  // The Codex executor and quota reader resolve one specific binary (codexCliPath) that the service PATH does not include.
  const codex = discoverTools('/nonexistent-dsh-tool-path').find(tool => tool.name === 'codex')!
  expect(codex.installed).toBe(true)
})

it('a scan shows every catalog model as discovered but only the configured DSH executor model as a dispatchable channel', async () => {
  const store = fakeStore({ provider: 'p', model: 'm1' })
  const groups = [{ id: 'p', name: 'Provider', models: [{ id: 'm1' }, { id: 'm2' }] }]
  const runtime = { store, models: async () => ({ default: { provider: 'p', model: 'm1' }, routableProviders: ['p'], groups, failures: [] }),
    magpie: async () => ({ status: 'ok', account_quotas: [{ account_ref: 'r', state: 'ok', windows: [{ remaining: 5 }] }],
      request_usage: [{ served_model: 'm1', provider: 'p', account_ref: 'r' }] }),
    codexQuota: async () => ({ status: 'unknown' }) } as never
  const result = await scanView(runtime)
  // Only the configured executor model is a real, selectable channel; its Magpie reading is kept.
  expect(result.channels.map(channel => channel.model)).toEqual(['m1'])
  expect(result.channels.find(channel => channel.model === 'm1')).toMatchObject({ availability: 'available', selectable: true })
  expect(result.discovered.find(item => item.model === 'm1')).toMatchObject({ dispatchable: true, state: 'executable' })
  // m2 is catalogued but is not the DSH dispatch route, so it is discovered-only rather than a channel.
  expect(result.discovered.find(item => item.model === 'm2')).toMatchObject({ dispatchable: false, state: 'discovered' })
})

it('never exposes a non-routable provider model as a usable channel', async () => {
  const store = fakeStore({ provider: 'ready', model: 'm1' })
  const groups = [{ id: 'ready', name: 'Ready', models: [{ id: 'm1' }] }, { id: 'cold', name: 'Cold', models: [{ id: 'm2' }] }]
  const runtime = { store, models: async () => ({ default: { provider: 'ready', model: 'm1' }, routableProviders: ['ready'], groups, failures: [] }),
    magpie: async () => ({ status: 'not-configured' }), codexQuota: async () => ({ status: 'unknown' }) } as never
  const result = await scanView(runtime)
  expect(result.channels.map(channel => channel.model)).toEqual(['m1'])
  expect(result.channels.some(channel => channel.model === 'm2')).toBe(false)
  expect(result.discovered.find(item => item.model === 'm2')).toMatchObject({ dispatchable: false, state: 'discovered' })
})

it('a scan never changes the saved authorization', async () => {
  const store = fakeStore({ provider: 'p', model: 'm1' })
  saveSelection(store as never, ['dsh/m1'])
  const groups = [{ id: 'p', name: 'Provider', models: [{ id: 'm1' }, { id: 'm2' }] }]
  const runtime = { store, models: async () => ({ default: { provider: 'p', model: 'm1' }, routableProviders: ['p'], groups, failures: [] }),
    magpie: async () => ({ status: 'not-configured' }), codexQuota: async () => ({ status: 'unknown' }) } as never
  await scanView(runtime)
  expect(selectionView(store as never)).toEqual({ explicit: true, enabled: ['dsh/m1'] })
})

it('a scan detects a newly added catalog model and reports detected tools', async () => {
  const store = fakeStore({ provider: 'p', model: 'm1' })
  let groups = [{ id: 'p', name: 'Provider', models: [{ id: 'm1' }] }]
  const runtime = { store, models: async () => ({ default: { provider: 'p', model: 'm1' }, groups, failures: [] }),
    magpie: async () => ({ status: 'not-configured' }), codexQuota: async () => ({ status: 'unknown' }) } as never
  const first = await scanView(runtime)
  expect(first.first).toBe(true)
  expect(first.tools.map(tool => tool.name)).toContain('cursor')
  groups = [{ id: 'p', name: 'Provider', models: [{ id: 'm1' }, { id: 'm2' }] }]
  const second = await scanView(runtime)
  expect(second.first).toBe(false)
  expect(second.diff.catalog.added).toContain('dsh:p:m2')
})

it('adds real Codex, Grok and AGY models to discovery with their source, never as channels', async () => {
  const store = fakeStore({ provider: 'p', model: 'm1' })
  const groups = [{ id: 'p', name: 'Provider', models: [{ id: 'm1' }] }]
  const runtime = { store, models: async () => ({ default: { provider: 'p', model: 'm1' }, groups, failures: [] }),
    magpie: async () => ({ status: 'not-configured' }), codexQuota: async () => ({ status: 'unknown' }),
    harnessModels: async () => [
      { harness: 'codex', provider: 'codex', status: 'ok', source: 'codex models_cache (t)', models: ['gpt-6-astra', 'gpt-5.6-sol'] },
      { harness: 'grok', provider: 'grok', status: 'ok', source: 'grok models_cache (t)', models: ['grok-4.7-build-fast', 'grok-4.7'] },
      { harness: 'agy', provider: 'agy', status: 'ok', source: 'agy models', models: ['gemini-3.8-flash-high', 'claude-sonnet-4-6'] },
    ] } as never
  const result = await scanView(runtime)
  expect(result.discovered.find(item => item.harness === 'codex' && item.model === 'gpt-6-astra'))
    .toMatchObject({ dispatchable: true, availability: 'unknown', state: 'availability-unknown', source: 'codex models_cache (t)' })
  expect(result.discovered.find(item => item.harness === 'grok' && item.model === 'grok-4.7-build-fast')).toMatchObject({ dispatchable: true })
  expect(result.discovered.find(item => item.harness === 'grok' && item.model === 'grok-4.7')).toMatchObject({ dispatchable: false, state: 'discovered' })
  expect(result.discovered.find(item => item.harness === 'agy' && item.model === 'gemini-3.8-flash-high')).toMatchObject({ dispatchable: true })
  expect(result.discovered.find(item => item.harness === 'agy' && item.model === 'claude-sonnet-4-6')).toMatchObject({ dispatchable: false })
  expect(result.channels.every(channel => channel.harness === 'dsh')).toBe(true)
  expect(selectionView(store as never)).toEqual({ explicit: false, enabled: null })
})

it('shows the last scan Harness model lists from cache without re-reading the CLIs', async () => {
  const store = fakeStore({ provider: 'p', model: 'm1' })
  store.set('models-scan', { fetchedAt: 't', providers: [], harnesses: {}, snapshot: { catalog: [], availability: {}, sources: {} },
    harnessModels: [{ harness: 'grok', provider: 'grok', status: 'ok', source: 'grok models_cache (t)', models: ['grok-4.7'] }] })
  const runtime = { store, models: async () => ({ default: { provider: 'p', model: 'm1' },
    groups: [{ id: 'p', name: 'Provider', models: [{ id: 'm1' }] }], failures: [] }),
    magpie: async () => ({ status: 'not-configured' }) } as never
  const view = await routingView(runtime)
  expect(view.discovered.find(item => item.harness === 'grok' && item.model === 'grok-4.7'))
    .toMatchObject({ dispatchable: false, state: 'discovered', source: 'grok models_cache (t)' })
})

it('treats Codex hidden or internal models as discovered-only, not dispatch candidates', async () => {
  const store = fakeStore({ provider: 'p', model: 'm1' })
  const groups = [{ id: 'p', name: 'Provider', models: [{ id: 'm1' }] }]
  const runtime = { store, models: async () => ({ default: { provider: 'p', model: 'm1' }, groups, failures: [] }),
    magpie: async () => ({ status: 'not-configured' }), codexQuota: async () => ({ status: 'unknown' }),
    harnessModels: async () => [{ harness: 'codex', provider: 'codex', status: 'ok', source: 'codex models_cache',
      models: ['gpt-6.1-sol', 'gpt-reserve', 'codex-auto-review'], hiddenModels: ['gpt-reserve', 'codex-auto-review'] }] } as never
  const result = await scanView(runtime)
  expect(result.discovered.find(item => item.model === 'gpt-6.1-sol')).toMatchObject({ dispatchable: true, availability: 'unknown' })
  expect(result.discovered.find(item => item.model === 'gpt-reserve')).toMatchObject({ dispatchable: false, state: 'discovered' })
  expect(result.discovered.find(item => item.model === 'codex-auto-review')).toMatchObject({ dispatchable: false, state: 'discovered' })
})

it('counts external Harness model changes and never reports a failed source as removed', async () => {
  const store = fakeStore({ provider: 'p', model: 'm1' })
  const groups = [{ id: 'p', name: 'Provider', models: [{ id: 'm1' }] }]
  const withSources = (sources: unknown) => ({ store,
    models: async () => ({ default: { provider: 'p', model: 'm1' }, groups, failures: [] }),
    magpie: async () => ({ status: 'not-configured' }), codexQuota: async () => ({ status: 'unknown' }),
    harnessModels: async () => sources } as never)
  await scanView(withSources([{ harness: 'grok', provider: 'grok', status: 'ok', source: 'grok models_cache', models: ['grok-4.7'] }]))
  const second = await scanView(withSources([{ harness: 'grok', provider: 'grok', status: 'ok', source: 'grok models_cache', models: ['grok-4.7', 'grok-4.8'] }]))
  expect(second.diff.catalog.added).toContain('grok:grok:grok-4.8')
  const failed = await scanView(withSources([{ harness: 'grok', provider: 'grok', status: 'failed', source: 'grok models_cache', models: [], error: 'boom' }]))
  expect(failed.diff.catalog.removed).not.toContain('grok:grok:grok-4.7')
  expect(failed.diff.catalog.removed).not.toContain('grok:grok:grok-4.8')
})
