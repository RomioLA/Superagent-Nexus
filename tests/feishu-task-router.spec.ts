import { describe, expect, it } from 'vitest'
import { taskKind, normalizedTask, cheapReadmeQuery, summarizeReadme, nativeTicketStatus } from '../src/sources/feishu-task-router.ts'
import { reportedCodexTokens } from '../src/app/tools/codex.ts'
describe('minimal Feishu intent recognizer (no task queue)', () => {
  it('accepts natural direct instructions without /task', () => {
    for (const request of ['修改 README.md 英文简介', '帮我修复测试仓库的错误',
      '在 README 底部添加一节 Testing', '请把 README 第二行改成英文', '实现一个新功能',
      '/task 修改 README.md', '/task 在 README 添加说明',
      '在 README.md 末尾增加一段简短的英文说明，创建 PR，不要合并。',
      '增加 README.md 的 Testing 小节']) {
      expect(taskKind(request)).toBe('write')
    }
    expect(normalizedTask('/task 只读 检查 README 标题')).toBe('检查 README 标题')
  })
  it('keeps questions, discussions and dangerous merge instructions out of automatic write routing', () => {
    for (const request of ['README 是否需要修改？', '为什么要修改 README', '你觉得应该重构吗',
      '我想讨论一下如何修改 README', '修改 README 后自动合并到main', '合并到main',
      '如果我修改 README 会怎样']) expect(taskKind(request)).toBeUndefined()
  })
  it('uses native read-only tickets for general inspection and local reads only for trivial queries', () => {
    expect(taskKind('检查 README.md 标题和简介')).toBe('read')
    expect(taskKind('/task 只读 审查代码有没有问题')).toBe('read')
    expect(taskKind('查看历史版本差异')).toBe('read')
    expect(taskKind('你好')).toBeUndefined()
    expect(cheapReadmeQuery('检查 README.md 标题与简介')).toBe(true)
    expect(cheapReadmeQuery('分析 README 的历史版本')).toBe(false)
    expect(summarizeReadme('# project\r\n\r\nShort intro\r\n')).toContain('标题：project\n简介：Short intro')
  })
  it('exposes native worker outcome through /result rather than dropping the summary', () => {
    const status = nativeTicketStatus({
      id: 'native-id', title: 'Fix README', createdAt: '', assignments: [
        { id: 'a', state: 'ended', createdAt: '', report: { state: 'ready', summary: 'Changes verified; PR opened', at: '' } },
      ],
    } as unknown as import('../src/core/index.ts').Ticket)
    expect(status).toContain('Changes verified; PR opened')
  })
  it('only reports Codex CLI aggregate token usage when observed', () => {
    expect(reportedCodexTokens('tokens used\n3,794\n')).toBe(3794)
    expect(reportedCodexTokens('result only')).toBeUndefined()
  })
})