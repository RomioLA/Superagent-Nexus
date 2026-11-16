/**
 * Model authorization: the user's explicit set of enabled logical routes, persisted in KV and read by both the panel and the
 * dispatch gate so the Router can only automatically choose inside that set. Scanning never widens authorization by itself.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type { HarnessName } from '../core/ports.ts'
import { KV } from '../kv.ts'
import { logicalModelId, type HarnessModelSource } from './routing.ts'
import type { Store } from './store.ts'
import { agyCliPath, codexCliPath, sharedCodexHome, sharedGrokHome } from './tools/cli-isolation.ts'

/** The user's explicit enabled routes (`enabled` = `harness/model` or a whole-harness `harness` key), or `undefined` = all. */
export type Selection = ReadonlySet<string> | undefined

/** The key under which a model is authorized. AGY is authorized as a family: the gemini-3.8-flash-* reasoning tiers share `3.8f`, and gemini-4-argon-* shares `4a`. Other Harnesses keep the bare logical model id. */
export const authorizationModelKey = (harness: HarnessName, model?: string): string | undefined => {
  if (!model) return undefined
  if (harness === 'agy') {
    if (model === '4a' || /^gemini-4-argon-/.test(model)) return '4a'
    if (model === '3.8f' || /^gemini-3\.8-flash-/.test(model)) return '3.8f'
    return logicalModelId(model)
  }
  return logicalModelId(model)
}

/** Key of one logical route: `harness/model` (normalized, with AGY families collapsed) or a whole-harness `harness` key. */
export const routeKey = (harness: HarnessName, model?: string): string => model ? `${harness}/${authorizationModelKey(harness, model)}` : harness

/** Read the persisted authorization; `undefined` means no explicit choice was saved, so every route stays authorized. */
export function readSelection(store: Pick<Store, 'get'>): Selection {
  const value = store.get(KV.models.selection)
  return value ? new Set(value.enabled) : undefined
}

/** Whether the exact logical route is inside the user's authorized set (an empty saved set authorizes nothing). */
export function isRouteAuthorized(selection: Selection, harness: HarnessName, model?: string): boolean {
  if (!selection) return true
  return selection.has(routeKey(harness, model)) || selection.has(harness)
}

/** Persist an explicit set of enabled routes (deduplicated and sorted) and return what was stored. */
export function saveSelection(store: Pick<Store, 'set'>, enabled: readonly string[]): { enabled: string[]; updatedAt: string } {
  const record = { enabled: [...new Set(enabled)].sort(), updatedAt: new Date().toISOString() }
  store.set(KV.models.selection, record)
  return record
}

/** What the panel renders for the authorizations: whether a choice exists and the enabled keys (null = everything). */
export function selectionView(store: Pick<Store, 'get'>): { explicit: boolean; enabled: string[] | null } {
  const value = store.get(KV.models.selection)
  return value ? { explicit: true, enabled: value.enabled } : { explicit: false, enabled: null }
}

/** A detected harness/tool CLI: `installed` is filesystem presence, `callable` is only claimed when a real interface exists. */
export interface ToolStatus {
  name: string
  installed: boolean
  callable: 'unknown' | 'no'
  status: 'supported' | 'unsupported' | 'not-installed'
}
const SUPPORTED_TOOLS = new Set(['grok', 'codex', 'agy'])
/** The exact binaries the executor adapters spawn, so tool detection matches real execution instead of the service PATH. */
const executorCliPaths = (name: string): string[] =>
  name === 'codex' ? [codexCliPath()] : name === 'agy' ? [agyCliPath()] : []
const cliCandidates = (name: string, path: string): string[] => [
  // Reuse the CLI locations the executor and quota readers resolve; Codex and AGY live outside the service PATH.
  ...executorCliPaths(name),
  join(homedir(), '.local', 'bin', name), join(homedir(), '.npm-global', 'bin', name), `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`,
  ...path.split(delimiter).filter(Boolean).map(entry => join(entry, name)),
]

/**
 * Probe the CLIs the panel cares about. A newly installed supported CLI is discovered by filesystem presence; an unsupported
 * execution interface such as Cursor is reported as `unsupported` (never assumed callable) instead of gaining a Harness.
 */
export function discoverTools(path: string = process.env.PATH ?? ''): ToolStatus[] {
  return [...new Set([...SUPPORTED_TOOLS, 'cursor'])].map(name => {
    const installed = cliCandidates(name, path).some(existsSync)
    const supported = SUPPORTED_TOOLS.has(name)
    return { name, installed, callable: supported && installed ? 'unknown' : 'no',
      status: !installed ? 'not-installed' : supported ? 'supported' : 'unsupported' }
  })
}

/** Error code of a failed local read, so a missing cache is reported distinctly from a corrupt one. */
const readErrorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : undefined
const readErrorText = (error: unknown): string =>
  (readErrorCode(error) ?? (error instanceof Error ? error.message : String(error))).slice(0, 200)

/**
 * Read each supported Harness's own model catalog from local data, without credentials and without throwing: Codex and Grok
 * keep a fetched `models_cache.json`, while AGY exposes its list through `agy models` and is queried only on an explicit scan.
 * A missing or unreadable source stays an explicit failed/not-installed reading with no models.
 */
export async function readHarnessModels(): Promise<HarnessModelSource[]> {
  const sources: HarnessModelSource[] = []
  try {
    const data = JSON.parse(await readFile(join(sharedCodexHome(), 'models_cache.json'), 'utf8')) as { models?: unknown; fetched_at?: unknown }
    const entries = Array.isArray(data.models) ? data.models : []
    const models = entries
      .map(item => (item && typeof item === 'object' ? (item as { slug?: unknown }).slug : undefined))
      .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0)
    // A model whose own metadata hides it (visibility=hide) or excludes it from the API is not a dispatch candidate.
    const hiddenModels = entries
      .filter(item => item && typeof item === 'object') as { slug?: unknown; visibility?: unknown; supported_in_api?: unknown }[]
    const hidden = hiddenModels
      .filter(item => item.visibility === 'hide' || item.supported_in_api === false)
      .map(item => item.slug)
      .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0)
    const at = typeof data.fetched_at === 'string' ? data.fetched_at : undefined
    sources.push({ harness: 'codex', provider: 'codex', status: 'ok', models, hiddenModels: hidden, source: `codex models_cache${at ? ` (${at})` : ''}` })
  } catch (error) {
    sources.push({ harness: 'codex', provider: 'codex', status: readErrorCode(error) === 'ENOENT' ? 'not-installed' : 'failed',
      models: [], source: 'codex models_cache', error: readErrorText(error) })
  }
  try {
    const data = JSON.parse(await readFile(join(sharedGrokHome(), 'models_cache.json'), 'utf8')) as { models?: unknown; fetched_at?: unknown }
    const table = data.models && typeof data.models === 'object' && !Array.isArray(data.models) ? data.models as Record<string, unknown> : {}
    const models = Object.keys(table).filter(id => id.length > 0)
    const at = typeof data.fetched_at === 'string' ? data.fetched_at : undefined
    sources.push({ harness: 'grok', provider: 'grok', status: 'ok', models, source: `grok models_cache${at ? ` (${at})` : ''}` })
  } catch (error) {
    sources.push({ harness: 'grok', provider: 'grok', status: readErrorCode(error) === 'ENOENT' ? 'not-installed' : 'failed',
      models: [], source: 'grok models_cache', error: readErrorText(error) })
  }
  try {
    const { stdout } = await promisify(execFile)(agyCliPath(), ['models'], { timeout: 20_000, maxBuffer: 1_000_000 })
    const models = stdout.split(/\r?\n/).map(line => line.split('\t')[0]?.trim() ?? '')
      .filter(id => /^[A-Za-z0-9._:@/-]+$/.test(id))
    sources.push({ harness: 'agy', provider: 'agy', status: 'ok', models, source: 'agy models' })
  } catch (error) {
    sources.push({ harness: 'agy', provider: 'agy', status: readErrorCode(error) === 'ENOENT' ? 'not-installed' : 'failed',
      models: [], source: 'agy models', error: readErrorText(error) })
  }
  return sources
}
