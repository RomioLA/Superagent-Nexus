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
        status: 'test', repository: 'Saworker/superagent-integration-test' },
        { id: 'other', name: '第二项目', aliases: ['第二项目'], status: 'test',
          repository: 'Saworker/second-repo', directory: '/tmp/second-repo' }],
    }))
    const acceptTask = vi.fn((_trigger: Trigger, _request: NativeTaskRequest) => ({ received: 'stored', ticketId: 'f'.repeat(32) }))
    const receive = vi.fn((_trigger: Trigger) => 'stored' as const)
    const lark = vi.fn()
    const ctx = {
      deployment: { repository: 'Saworker/superagent-integration-test' },
      acceptTask, receive,
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
    // A new top-level message that refers to an old task must reach DSH's
    // original cross-thread Ticket lookup/attach flow; not the new-Ticket ingress.
    const historical = await handleFeishuChat(ctx, msg('查看灰姑娘刚刚那个 PR #8 的状态', 'om_history'))
    expect(historical).toBe(true)
    const historicalWrite = await handleFeishuChat(ctx, msg('修改上次那个任务的说明', 'om_history_edit'))
    expect(historicalWrite).toBe(true)
    expect(receive).toHaveBeenCalledTimes(2)
    expect(receive.mock.calls[0]![0].meta).toMatchObject({ projectRepository: 'Saworker/superagent-integration-test' })
    expect(acceptTask).toHaveBeenCalledTimes(1)
    expect(lark).not.toHaveBeenCalled()
    const next = await handleFeishuChat(ctx, msg('在 README 末尾添加一段英文 Testing 说明'))
    expect(next).toBe(true)
    expect(acceptTask).toHaveBeenCalledTimes(1)
    const state = JSON.parse(await readFile(join(cfgDir, 'chat-router-state.json'), 'utf8'))
    expect(state.handled).toEqual([id, 'om_history', 'om_history_edit'])
    const projectTask = await handleFeishuChat(ctx, msg('在第二项目的 README 中增加说明', 'om_second'))
    expect(projectTask).toBe(true)
    expect(acceptTask).toHaveBeenCalledTimes(2)
    const second = acceptTask.mock.calls[1]!
    expect(second[0].meta).toMatchObject({ projectRepository: 'Saworker/second-repo', projectRoot: '/tmp/second-repo' })
    expect(second[1].note).toContain('omit pr_number')
    const crossThread = await handleFeishuChat(ctx, msg('第二项目上次那个 PR 怎么样了？', 'om_second_followup'))
    expect(crossThread).toBe(true)
    expect(acceptTask).toHaveBeenCalledTimes(2)
    expect(receive).toHaveBeenCalledTimes(3)
    expect(receive.mock.calls[2]![0].meta).toMatchObject({
      projectRepository: 'Saworker/second-repo', projectRoot: '/tmp/second-repo',
    })
    expect(existsSync(join(cfgDir, 'task-router-state.json'))).toBe(false)
  })
})