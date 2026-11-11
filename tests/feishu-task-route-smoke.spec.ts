import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Trigger } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
const { home } = vi.hoisted(() => ({ home: `/tmp/feishu-native-intake-${process.pid}-${Date.now()}` }))
vi.mock('node:os', async importOriginal => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => home }))
import { receiveFeishu } from '../src/sources/feishu-loops.ts'

const actor = 'ou_owner'
const chatId = 'oc_chat'
const makeTrigger = (text: string, id: string): Trigger => ({ id: id.padEnd(32, '0').slice(0, 32), actor: { id: actor, source: 'feishu' },
  human: true, text, source: 'feishu', at: new Date().toISOString(), threads: [{ source: 'feishu', id: `${chatId}:${id}` }],
  meta: { direct: true, chatId, messageId: id } }) as Trigger
afterAll(async () => { await rm(home, { recursive: true, force: true }) })

describe('Feishu native ingress', () => {
  it('sends natural requests, long chat, cancel, query, continuation, and repeated project commands to native receive unchanged', async () => {
    const cfgDir = join(home, '.config/superagent')
    await mkdir(cfgDir, { recursive: true })
    await writeFile(join(cfgDir, 'chat-router.json'), JSON.stringify({ enabled: true, allowedUser: actor,
      projects: [{ id: 'alpha', name: 'Alpha', aliases: ['阿尔法'], status: 'test', repository: 'org/alpha' }] }))
    const received: Trigger[] = []
    const state = new Map<string, unknown>()
    const ctx = { deployment: { feishu: { brand: 'feishu' } },
      receive: (item: Trigger) => { received.push(item); return 'stored' },
      state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => state.set(key, value) },
      triggers: { get: () => undefined },
      threads: { describe: vi.fn() },
    } as unknown as SourceContext
    const messages = [
      '请在 README 末尾补充英文 Testing 说明',
      '长消息'.repeat(4000),
      '取消刚才的改动',
      '刚才的任务现在怎么样？',
      '继续上次那个任务',
      '/project 阿尔法',
      '/project 阿尔法',
      '查看阿尔法上次 PR 状态',
    ]
    for (const [index, text] of messages.entries()) await receiveFeishu(ctx, makeTrigger(text, `om_${index}`))
    expect(received).toHaveLength(messages.length)
    expect(received.map(item => item.text)).toEqual(messages)
    expect(received[1]!.text).toHaveLength(messages[1]!.length)
    expect(received[5]!.meta.projectSelection).toBe('alpha')
    expect(received[6]!.meta.projectSelection).toBe('alpha')
    expect(received[7]!.meta.projectId).toBe('alpha')
    expect(ctx.threads.describe).toHaveBeenCalledTimes(messages.length)
    expect('acceptTask' in ctx).toBe(false)
    expect('stopTask' in ctx).toBe(false)
    expect('retryTask' in ctx).toBe(false)
  })
  it('still sends a message to native receive when project configuration cannot be parsed', async () => {
    const cfgDir = join(home, '.config/superagent')
    await mkdir(cfgDir, { recursive: true })
    await writeFile(join(cfgDir, 'chat-router.json'), '{broken')
    const receive = vi.fn()
    const ctx = { deployment: { feishu: { brand: 'feishu' } }, receive,
      state: { get: () => undefined, set: vi.fn() }, triggers: { get: () => undefined }, threads: { describe: vi.fn() },
    } as unknown as SourceContext
    const message = makeTrigger('继续上次任务', 'om_badconfig')
    await receiveFeishu(ctx, message)
    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive.mock.calls[0]![0]).toMatchObject({ text: message.text,
      meta: { projectRequired: true, projects: [], projectConfigError: 'invalid' } })
  })
})
