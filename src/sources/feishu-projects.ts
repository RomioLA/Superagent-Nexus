/** Optional project directory mapping; every message still goes through native Intake and Eval. */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'

export const ProjectSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), aliases: z.array(z.string()).default([]),
  status: z.enum(['test', 'disabled']), repository: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i).optional(),
  directory: z.string().refine(isAbsolute).optional(), localOnly: z.boolean().optional(),
})
export type Project = z.infer<typeof ProjectSchema>
const ConfigSchema = z.object({ enabled: z.boolean(), allowedUser: z.string(), projects: z.array(ProjectSchema) })

/** Several matches are ambiguous, never a reason to select the first registered (test) repository. */
export function mentionedProjects(text: string, projects: Project[]): Project[] {
  const lower = text.toLowerCase()
  return projects.filter(project => [project.name, project.repository, ...project.aliases]
    .some(alias => alias && lower.includes(alias.toLowerCase())))
}
export async function projectContext(ctx: SourceContext, trigger: Trigger): Promise<Trigger> {
  // Backfill and live delivery can replay the same source ID. The Engine's
  // stored trigger is authoritative; never let replayed commands rewrite chat state.
  const stored = ctx.triggers.get(trigger.id)
  if (stored) return stored
  let raw: string
  try { raw = await readFile(join(homedir(), '.config/superagent/chat-router.json'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return trigger
    return { ...trigger, meta: { ...trigger.meta, projectRequired: true, projects: [], projectConfigError: 'unreadable' } }
  }
  // Project routing is optional metadata. A broken local config must never stop
  // the source from handing the original message to native Intake/Eval.
  let cfg: z.infer<typeof ConfigSchema>
  try { cfg = ConfigSchema.parse(JSON.parse(raw)) }
  catch { return { ...trigger, meta: { ...trigger.meta, projectRequired: true, projects: [], projectConfigError: 'invalid' } } }
  if (!cfg.enabled || !trigger.human || trigger.meta.direct !== true || trigger.actor.id !== cfg.allowedUser) return trigger
  const chatId = String(trigger.meta.chatId ?? '')
  const command = /^\/project\s+(.+)$/i.exec(trigger.text.trim())
  const named = command && cfg.projects.filter(p => [p.id, p.name, ...p.aliases]
    .some(alias => alias.toLowerCase() === command[1]!.trim().toLowerCase()))
  const chosen = named && named.length === 1 && named[0]!.status !== 'disabled' ? named[0] : undefined
  const current = cfg.projects.find(p => p.id === ctx.state.get(KV.feishu.project(chatId)) && p.status !== 'disabled')
  // Only an exact selection command changes the chat's project. Mentions in
  // ordinary messages (including history and follow-ups) are not selections.
  if (chosen && chosen.id !== current?.id) ctx.state.set(KV.feishu.project(chatId), chosen.id)
  const selected = command ? chosen : current
  return { ...trigger, meta: { ...trigger.meta, projectRequired: true, projects: cfg.projects,
    ...(selected ? { projectId: selected.id } : {}),
    ...(command ? { projectSelection: chosen?.id ?? 'unresolved' } : {}) } }
}
