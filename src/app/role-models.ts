/** Resolves and seeds per-role and per-Ticket models on sessions without mutating the global DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel } from '../policy.ts'

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/** The disposer of each live Agent's most recent installed model selection, so a re-seat replaces its listeners instead of stacking them. */
const applied = new WeakMap<Agent, () => void>()

/**
 * Install one mutable-free selection on an Agent's request path for the next request, then let its durable header carry it.
 * This mirrors the existing session-level seeding mechanism: append the `model/selection` event a resumed session reads back,
 * and force that pair into prompt assembly and the request config for the first request after the seat. It never calls
 * `selectModel`, which would overwrite the deployment's global default.
 */
async function installSelection(ctx: Context, agent: Agent, selected: ModelSelection): Promise<void> {
  applied.get(agent)?.()
  let initial = true
  let assembled: ModelSelection | undefined
  const disposers = [
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const selection = initial ? selected : undefined
      const result = await next()
      assembled = selection
      return selection ? { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } } : result
    }, { prepend: true }),
    agent.ctx.on('agent/request', async (_payload, next) => {
      const result = await next()
      if (!assembled) return result
      const { reasoningEffort: _inherited, ...rest } = result
      return { ...rest, ...assembled }
    }, { prepend: true }),
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && (event.type === 'request/header' || event.type === 'model/selection')) initial = false
    }),
  ]
  applied.set(agent, () => disposers.forEach(dispose => dispose()))
  agent.session.append('model/selection', selected)
  await ctx.sessionPersistence.flush()
}

/** Seed a role's configured model onto a brand-new session before its first request, leaving later manual or durable selections intact. */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void> {
  if (!model) return
  if (agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')) return
  await installSelection(ctx, agent, await resolveRoleModel(ctx, model))
}

/**
 * Seat `model` on `agent`. A brand-new session is seeded before its first request; an existing session is re-seated only
 * when `force` is set and its durable header still names a different route, so a Ticket that explicitly changes its DSH model
 * on a continuation switches on the next request while an unchanged continuation keeps its durable selection.
 */
export async function seedRoleModel(ctx: Context, agent: Agent, model: RoleModel | null, force = false): Promise<void> {
  if (!model) return
  const fresh = !agent.session.requestHeader() && !agent.session.snapshotEvents().some(event => event.type === 'model/selection')
  if (fresh) return initializeRoleModel(ctx, agent, model)
  if (!force) return
  const selected = await resolveRoleModel(ctx, model)
  const current = agent.session.requestHeader()?.config
  if (current && current.provider === selected.provider && current.model === selected.model) return
  await installSelection(ctx, agent, selected)
}
