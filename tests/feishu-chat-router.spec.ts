import { describe, expect, it } from 'vitest'
import { intentOf, plainText, projectOf, projectList, arrivalWindow,
  nativeTaskRequest, referencesPriorTicket } from '../src/sources/feishu-chat-router.ts'
import type { Trigger } from '../src/core/index.ts'
const projects = [
  { id: 'test', name: '测试仓库', aliases: ['integration-test'], status: 'test' as const },
  { id: 'cinderella', name: '灰姑娘', aliases: ['Cinderella'], status: 'disabled' as const },
]
const trigger = { id: '0123456789abcdef0123456789abcdef' } as Trigger
describe('single-user Feishu chat/native Ticket integration', () => {
  it('normalizes Feishu JSON and plain text', () => {
    expect(plainText('你好')).toBe('你好')
    expect(plainText('{"text":"测试"}')).toBe('测试')
  })
  it('classifies natural instructions as tasks but not questions', () => {
    expect(intentOf('/help')).toBe('help')
    expect(intentOf('/project 测试仓库')).toBe('select')
    expect(intentOf('修改 README')).toBe('task')
    expect(intentOf('在 README 中添加一段说明')).toBe('task')
    expect(intentOf('帮我检查仓库')).toBe('task')
    expect(intentOf('README 是否需要修改？')).toBe('chat')
    expect(intentOf('你好')).toBe('chat')
  })
  it('hands explicit history references to native DSH, not the chat or fresh-task router', () => {
    for (const message of [
      '灰姑娘刚刚那个 PR 现在怎么样了？',
      '继续修复上次那个任务',
      '检查此前的工单有没有完成',
      'https://github.com/RomioLA/cinderella-companion/pull/8 的情况',
      'PR #6 审核到哪了',
      'Ticket 83f9b10375c64f577019c856a3243237 的结果',
    ]) expect(referencesPriorTicket(message), message).toBe(true)
    for (const message of [
      'PR 是什么意思？', '你好', '修改 README 并创建 PR', '/task 修改上次那个 PR',
      '在 README 里增加 Testing 小节', '我想讨论历史话题是什么',
    ]) expect(referencesPriorTicket(message), message).toBe(false)
  })
  it('keeps single-project selection without additional per-project user roles', () => {
    expect(projectOf('检查 Cinderella', projects)?.status).toBe('disabled')
    expect(projectList(projects)).toContain('暂未接入')
    expect(projectOf('你好', projects)).toBeUndefined()
    expect(projectOf('Add a Testing section', projects)).toBeUndefined()
  })
  it('constructs native worktree ticket instructions instead of a second Codex job', () => {
    const request = nativeTaskRequest(trigger, '修改 README 标题', 'write', 'Saworker/superagent-integration-test')
    expect(request.name).toBe('feishu-0123456789')
    expect(request.note).toContain('orchestrator_codex')
    expect(request.note).toContain('native DSH Ticket worktree')
    expect(request.note).toContain('PR')
    expect(request.scope).toContain('Saworker/superagent-integration-test')
    const readonly = nativeTaskRequest(trigger, '检查 README', 'read', 'Saworker/superagent-integration-test')
    expect(readonly.note).toContain('mode=read-only')
    const secondary = nativeTaskRequest(trigger, '修改 README', 'write', 'Saworker/second-repo', 'Saworker/superagent-integration-test')
    expect(secondary.note).toContain('include the PR URL')
    expect(secondary.scope).toContain('Saworker/second-repo')
    const local = nativeTaskRequest(trigger, '修改 README，但只在本地，不创建PR', 'write', 'Saworker/superagent-integration-test')
    expect(local.note).toContain('Do not commit')
    expect(local.note).toContain('Do not commit, push, merge, deploy or create a PR')
    expect(local.acknowledgement).toContain('不提交或创建 PR')
  })
  it('allows timely messages while avoiding accidental execution of old requests', () => {
    const now = Date.parse('2026-11-08T14:00:00Z')
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
    expect(arrivalWindow(at(4), true, now)).toBe('fresh')
    expect(arrivalWindow(at(20), true, now)).toBe('fresh')
    expect(arrivalWindow(at(20), false, now)).toBe('fresh')
    expect(arrivalWindow(at(24 * 60 + 1), true, now)).toBe('archived')
  })
})