/** Cross-project GitHub PR/CI tracking: repository-scoped Threads, scope and pull binding for authorized repos. */
import { describe, expect, it, vi } from 'vitest'
import { githubKind, type GithubConfig } from '../src/sources/github.ts'
import { commentTrigger, githubThreadId, issueTrigger, parseGithubThreadId } from '../src/sources/github-trigger.ts'
import { claimPull, observePull, pullsOf, readPull } from '../src/sources/github-pull.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

const PRIMARY = 'acme/widgets'
const GADGETS = 'acme/gadgets'
const config = { repository: PRIMARY, repositories: [GADGETS] } as unknown as GithubConfig

describe('repository-scoped GitHub Threads', () => {
  it('keeps the primary repository\'s bare number and qualifies every other repository', () => {
    expect(githubThreadId(PRIMARY, PRIMARY, 6)).toBe('6')
    expect(githubThreadId(undefined, PRIMARY, 6)).toBe('6')
    expect(githubThreadId(GADGETS, PRIMARY, 6)).toBe('acme/gadgets#6')
    expect(parseGithubThreadId('6')).toEqual({ number: 6 })
    expect(parseGithubThreadId('acme/gadgets#6')).toEqual({ repository: 'acme/gadgets', number: 6 })
  })
  it('builds the same PR number in two projects as two distinct Threads', () => {
    const primary = commentTrigger({ id: 1, body: 'x', user: { login: 'alice' } }, { number: 6, isPr: true }, 'conversation', 'agent-bot')
    const other = commentTrigger({ id: 1, body: 'x', user: { login: 'alice' } }, { number: 6, isPr: true, repository: GADGETS, primary: PRIMARY }, 'conversation', 'agent-bot')
    expect(primary.threads).toEqual([{ source: 'github', id: '6' }])
    expect(other.threads).toEqual([{ source: 'github', id: 'acme/gadgets#6' }])
    expect(other.channel?.address).toMatchObject({ repository: GADGETS })
    expect(issueTrigger({ number: 6, title: 't', body: '', user: { login: 'alice' }, created_at: '2026-01-01T00:00:00Z', html_url: 'u' } as never,
      'agent-bot', { repository: GADGETS, primary: PRIMARY }).threads).toEqual([{ source: 'github', id: 'acme/gadgets#6' }])
  })
})

describe('GitHub scope for authorized project repositories', () => {
  const scope = (meta: Record<string, unknown>) => githubKind.scope!({ meta }, config)
  it('listens to the primary and every authorized repository', () => {
    expect(scope({ kind: 'pull', repository: PRIMARY })).toMatchObject({ listened: true })
    expect(scope({ kind: 'pull', repository: GADGETS })).toMatchObject({ listened: true })
    // A legacy Trigger without a repository is the primary, so historical Threads keep working.
    expect(scope({ kind: 'pull' })).toMatchObject({ listened: true })
  })
  it('rejects a repository the operator did not authorize instead of guessing one', () => {
    expect(scope({ kind: 'pull', repository: 'acme/other' })).toEqual({ listened: false, reason: 'repository_not_authorized' })
  })
})

const ticket = (id: string, name: string, origin: string, follows: Ticket['follows'] = []): Ticket => ({
  id, title: id, origin: { triggerId: origin, triggerIds: [] }, execution: { name }, follows,
} as unknown as Ticket)

interface Ctx { ctx: SourceContext; binds: { id: string; thread: { source: string; id: string }; own: boolean }[]; closed: { id: string; outcome: string }[] }
const makeCtx = (): Ctx => {
  const tickets = new Map<string, Ticket>([
    ['tA', ticket('tA', 'fix-a', 'srcA', [{ thread: 'github:6', own: true }])],
    ['tB', ticket('tB', 'fix-b', 'srcB')],
  ])
  const triggers = new Map<string, Trigger>([
    ['srcA', { id: 'srcA', source: 'github', meta: { isPr: true, number: 6 }, threads: [{ source: 'github', id: '6' }] } as unknown as Trigger],
    ['srcB', { id: 'srcB', source: 'github', meta: { isPr: true, number: 6, repository: GADGETS }, threads: [{ source: 'github', id: 'acme/gadgets#6' }] } as unknown as Trigger],
  ])
  const binds: Ctx['binds'] = []
  const closed: Ctx['closed'] = []
  const commands = { forRepository: vi.fn((repository: string) => {
    const scoped = { api: vi.fn(async () => ({ state: 'open', html_url: `https://github.com/${repository}/pull/6`,
      user: { login: 'agent-bot' }, head: { sha: 'abc', ref: 'agent/fix-b', repo: { full_name: repository } } })) }
    return { ...scoped, withSignal: () => scoped }
  }) }
  const ctx = {
    deployment: { repository: PRIMARY, github: { login: 'agent-bot', noreply: 'x@example.invalid' } },
    config: () => config,
    commands,
    atomic: <T>(work: () => T) => work(),
    tickets: {
      get: (id: string) => tickets.get(id), open: () => [...tickets.values()].filter(item => !item.ended),
      bindThread: (id: string, thread: { source: string; id: string }, own: boolean) => {
        binds.push({ id, thread, own })
        const current = tickets.get(id)!
        current.follows = [...current.follows ?? [], { thread: `${thread.source}:${thread.id}`, own }]
      },
      threadClosed: (thread: { source: string; id: string }, outcome: 'merged' | 'closed') => closed.push({ id: thread.id, outcome }),
    },
    threads: { patch: () => {}, describe: () => {} },
    triggers: { get: (id: string) => triggers.get(id) },
  } as unknown as SourceContext
  return { ctx, binds, closed }
}
const pull = (repository: string) => ({ number: 6, state: 'open', html_url: `https://github.com/${repository}/pull/6`, user: { login: 'agent-bot' },
  head: { sha: 'abc', ref: 'agent/fix-b', repo: { full_name: repository } }, repository })

describe('cross-project pull binding', () => {
  it('reads a PR from the repository the Ticket targets, and refuses an unauthorized one', async () => {
    const { ctx } = makeCtx()
    const pr = await readPull(ctx, GADGETS, 6)
    expect(pr.repository).toBe(GADGETS)
    await expect(readPull(ctx, 'acme/other', 6)).rejects.toThrow('does not authorize tracking acme/other')
  })
  it('does not let the same PR number in another repository claim or bind a Ticket', () => {
    const { ctx, binds } = makeCtx()
    expect(claimPull(ctx, 'tA', pull(GADGETS))).toContain('does not belong to this ticket')
    expect(binds).toHaveLength(0)
  })
  it('binds a Ticket\'s own PR under its repository-qualified Thread, leaving the primary #6 untouched', () => {
    const { ctx, binds } = makeCtx()
    expect(claimPull(ctx, 'tB', pull(GADGETS))).toBeUndefined()
    expect(binds).toEqual([{ id: 'tB', thread: { source: 'github', id: 'acme/gadgets#6' }, own: true }])
    expect(pullsOf(ctx.tickets.get('tB')!, true)).toEqual([{ repository: GADGETS, number: 6 }])
    expect(pullsOf(ctx.tickets.get('tA')!, true)).toEqual([{ number: 6 }])
  })
  it('closes only the Ticket following that repository\'s PR', async () => {
    const { ctx, closed } = makeCtx()
    claimPull(ctx, 'tB', pull(GADGETS))
    await observePull(ctx, { ...pull(GADGETS), state: 'closed', merged: true, merged_at: '2026-01-02T00:00:00Z' })
    expect(closed).toEqual([{ id: 'acme/gadgets#6', outcome: 'merged' }])
  })
})
