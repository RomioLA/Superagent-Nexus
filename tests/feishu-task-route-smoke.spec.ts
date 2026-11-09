import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeTaskRequest, SourceContext } from '../src/sources/host.ts'
import type { Trigger } from '../src/core/index.ts'
const { home } = vi.hoisted(() => ({ home: '/tmp/sa-native-flow-' + process.pid + '-' + Date.now() }))
vi.mock('node:os', async importOriginal => ({
  ...(await importOriginal<typeof import('node:os')>()), homedir: () => home,
}))
import { handleFeishuChat } from '../src/sources/feishu-chat-router.ts'
const actor = 'ou_test'
const chatId = 'oc_test'
const id = 'om_test'
const msg = (text: string, messageId = id): Trigger => ({
  id: '0123456789abcdef0123456789abcdef',
  actor: { id: actor, source: 'feishu' },
  human: true, text, source: 'feishu', at: new Date().toISOString(),
  threads: [{ source: 'feishu', id: chatId + ':' + messageId }],
  meta: { direct: true, chatId, messageId },
}) as Trigger
afterAll(async () => { await rm(home, { recursive: true, force: true }) })
describe('Feishu → native DSH Ticket', () => {
  it('records only chat dedup and calls native acceptTask exactly once for natural instructions', async () => {
    const cfgDir = join(home, '.config/superagent')
    await mkdir(cfgDir, { recursive: true })
    await writeFile(join(cfgDir, 'chat-router.json'), JSON.stringify({
      enabled: true, allowedUser: actor,
      projects: [{ id: 'test', name: 'Super-agent 测试仓库', aliases: ['测试仓库'],
        status: 'test', repository: 'Saworker/superagent-integration-test' }],
    }))
    const acceptTask = vi.fn((_trigger: Trigger, _request: NativeTaskRequest) => ({ received: 'stored', ticketId: 'f'.repeat(32) }))
    const lark = vi.fn()
    const ctx = {
      deployment: { repository: 'Saworker/superagent-integration-test' },
      acceptTask,
      commands: { lark },
    } as unknown as SourceContext
    const first = await handleFeishuChat(ctx, msg('在 README 末尾添加一段英文 Testing 说明'))
    expect(first).toBe(true)
    expect(acceptTask).toHaveBeenCalledTimes(1)
    expect(acceptTask.mock.calls[0]![1]).toMatchObject({ name: 'feishu-0123456789' })
    expect(lark).not.toHaveBeenCalled()
    // Follow-ups in a native Ticket thread must pass through the DSH Source/Engine.
    const followup = { ...msg('已经做完了吗？', 'om_followup'), meta: {
      direct: true, chatId, messageId: 'om_followup', rootId: id,
    } } as Trigger
    expect(await handleFeishuChat(ctx, followup)).toBe(false)
    expect(acceptTask).toHaveBeenCalledTimes(1)
    const next = await handleFeishuChat(ctx, msg('在 README 末尾添加一段英文 Testing 说明'))
    expect(next).toBe(true)
    expect(acceptTask).toHaveBeenCalledTimes(1)
    const state = JSON.parse(await readFile(join(cfgDir, 'chat-router-state.json'), 'utf8'))
    expect(state.handled).toEqual([id])
    expect(existsSync(join(cfgDir, 'task-router-state.json'))).toBe(false)
  })
})