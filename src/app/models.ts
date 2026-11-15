/**
 * Model authorization: the user's explicit set of enabled logical routes, persisted in KV and read by both the panel and the
 * dispatch gate so the Router can only automatically choose inside that set. Scanning never widens authorization by itself.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { HarnessName } from '../core/ports.ts'
import { KV } from '../kv.ts'
import { logicalModelId } from './routing.ts'
import type { Store } from './store.ts'

/** The user's explicit enabled routes (`enabled` = `harness/model` or a whole-harness `harness` key), or `undefined` = all. */
export type Selection = ReadonlySet<string> | undefined

/** Key of one logical route: `harness/model` (normalized to the bare model id) or a whole-harness `harness` key. */
export const routeKey = (harness: HarnessName, model?: string): string => model ? `${harness}/${logicalModelId(model)}` : harness

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
const cliCandidates = (name: string, path: string): string[] => [
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
