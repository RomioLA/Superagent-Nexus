import { describe, expect, it } from 'vitest'
import { environmentOf } from '../src/app/execution-environment.ts'
import { githubKind } from '../src/sources/github.ts'
import type { Deployment } from '../src/deployment.ts'
import type { Trigger } from '../src/core/index.ts'
import type { SourceRegistry } from '../src/sources/registry.ts'
import type { Settings } from '../src/policy.ts'

const deployment = { repository: 'Saworker/superagent-integration-test', github: {
  login: 'Saworker', noreply: 'test@example.invalid', cli: '/fake/gh',
} } as Deployment

describe('per-Ticket project environment using native DSH infrastructure', () => {
  const trigger = { source: 'feishu', meta: {
    projectRepository: 'Saworker/second-repo', projectRoot: '/tmp/second-repo',
  }, threads: [{ source: 'feishu', id: 'direct' }] } as unknown as Trigger
  const oldTrigger = { source: 'feishu', meta: {}, threads: [{ source: 'feishu', id: 'direct' }] } as Trigger
  const githubVars = (source: Trigger) => githubKind.environment!.values({
    deployment, config: {} as never, trigger: source,
  })
  it('supplies the selected GitHub repository to the existing worker environment', () => {
    expect(githubVars(trigger).DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe('Saworker/second-repo')
    expect(githubVars(oldTrigger).DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe('Saworker/superagent-integration-test')
  })
  it('supplies the local project root to the existing worktree prepare process', () => {
    const sources = { environments: () => [] } as unknown as SourceRegistry
    const settings = { executor: { blockedCommands: [] } } as unknown as Settings
    const ticket = { id: 't', directory: '/tmp/work/t', name: 'work-t' }
    const vars = (source: Trigger) => environmentOf({ deployment, sources, settings, ticket, trigger: source })
    const of = (source: Trigger, name: string) => vars(source).find(v => v.key === name)?.value
    expect(of(trigger, 'DSH_SUPERAGENT_PROJECT_ROOT')).toBe('/tmp/second-repo')
    expect(of(oldTrigger, 'DSH_SUPERAGENT_PROJECT_ROOT')).toBe('')
    expect(of(trigger, 'DSH_SUPERAGENT_DIR')).toBe('/tmp/work/t')
  })
})
