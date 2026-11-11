import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Trigger } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
const { home } = vi.hoisted(() => ({ home: `/tmp/feishu-projects-${process.pid}-${Date.now()}` }))
vi.mock('node:os', async importOriginal => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => home }))
import { projectContext } from '../src/sources/feishu-projects.ts'

const configPath = join(home, '.config/superagent/chat-router.json')
const config = { enabled: true, allowedUser: 'ou_owner', projects: [
  { id: 'alpha', name: 'Alpha', aliases: ['阿尔法', 'alpha-repo'], status: 'test', repository: 'org/alpha' },
  { id: 'beta', name: 'Beta', aliases: ['贝塔'], status: 'test', repository: 'org/beta' },
] }
const trigger = (text: string, id = 'a'.repeat(32)): Trigger => ({ id, actor: { id: 'ou_owner', source: 'feishu' }, human: true,
  text, source: 'feishu', at: new Date().toISOString(), threads: [{ source: 'feishu', id: 'oc_chat:om_msg' }],
  meta: { direct: true, chatId: 'oc_chat', messageId: 'om_msg' } }) as Trigger
const makeContext = () => {
  const data = new Map<string, unknown>()
  const stored = new Map<string, Trigger>()
  return { state: { get: (key: string) => data.get(key), set: (key: string, value: unknown) => data.set(key, value) },
    triggers: { get: (id: string) => stored.get(id) }, stored } as unknown as SourceContext & { stored: Map<string, Trigger> }
}
const writeConfig = async (value: unknown) => {
  await mkdir(join(home, '.config/superagent'), { recursive: true })
  await writeFile(configPath, typeof value === 'string' ? value : JSON.stringify(value))
}
afterAll(async () => { await rm(home, { recursive: true, force: true }) })

describe('Feishu project context', () => {
  it('routes a unique explicit /project alias and keeps that choice across ordinary follow-ups', async () => {
    await writeConfig(config)
    const ctx = makeContext()
    const selected = await projectContext(ctx, trigger('/project 阿尔法'))
    expect(selected.meta).toMatchObject({ projectId: 'alpha', projectSelection: 'alpha' })
    const followup = await projectContext(ctx, trigger('查看上次阿尔法 PR 的状态'))
    expect(followup.meta).toMatchObject({ projectId: 'alpha' })
    expect(followup.meta.projectSelection).toBeUndefined()
  })
  it('does not infer a project from message mentions or switch to the first/default project', async () => {
    await writeConfig(config)
    const ctx = makeContext()
    const mention = await projectContext(ctx, trigger('查看 Alpha 和 Beta 上次的任务'))
    expect(mention.meta.projectId).toBeUndefined()
    const explicit = await projectContext(ctx, trigger('/project Beta'))
    expect(explicit.meta.projectId).toBe('beta')
    const history = await projectContext(ctx, trigger('另一个项目 Alpha 里的旧记录怎样了？'))
    expect(history.meta.projectId).toBe('beta')
  })
  it('leaves state unchanged for repeated and unresolved selection commands', async () => {
    await writeConfig(config)
    const ctx = makeContext()
    await projectContext(ctx, trigger('/project Alpha'))
    expect((await projectContext(ctx, trigger('/project Alpha'))).meta).toMatchObject({ projectId: 'alpha', projectSelection: 'alpha' })
    const unresolved = await projectContext(ctx, trigger('/project not registered'))
    expect(unresolved.meta).toMatchObject({ projectSelection: 'unresolved' })
    expect(unresolved.meta.projectId).toBeUndefined()
    expect((await projectContext(ctx, trigger('continue'))).meta.projectId).toBe('alpha')
  })
  it('blocks project routing on broken config without swallowing the native message; a missing file preserves normal behavior', async () => {
    const ctx = makeContext()
    await writeConfig('{broken')
    const original = trigger('长消息'.repeat(5000))
    expect(await projectContext(ctx, original)).toMatchObject({ text: original.text,
      meta: { projectRequired: true, projects: [], projectConfigError: 'invalid' } })
    await writeConfig({ enabled: 'yes' })
    expect(await projectContext(ctx, original)).toMatchObject({
      meta: { projectRequired: true, projects: [], projectConfigError: 'invalid' } })
    await rm(configPath)
    expect(await projectContext(ctx, original)).toBe(original)
  })
  it('does not let a replayed older selection command overwrite the newer chat choice', async () => {
    await writeConfig(config)
    const ctx = makeContext()
    const oldCommand = trigger('/project Alpha', 'a'.repeat(32))
    const oldSnapshot = await projectContext(ctx, oldCommand)
    ctx.stored.set(oldCommand.id, oldSnapshot)
    await projectContext(ctx, trigger('/project Beta', 'b'.repeat(32)))
    expect((await projectContext(ctx, oldCommand)).meta.projectId).toBe('alpha')
    expect((await projectContext(ctx, trigger('continue', 'c'.repeat(32)))).meta.projectId).toBe('beta')
  })
})
