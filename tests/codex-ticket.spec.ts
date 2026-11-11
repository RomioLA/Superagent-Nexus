import { describe, expect, it } from 'vitest'
import { reportedCodexTokens, ticketCodexTool } from '../src/app/tools/codex.ts'
import type { Ticket } from '../src/core/index.ts'
describe('Codex is a native Executor tool, not an independent job scheduler', () => {
  it('exposes one worktree-scoped tool with read-only/write defaults', () => {
    const ticket = { id: 'ticket', execution: { directory: '/tmp/dsh-ticket', name: 'ticket', assignment: '' } } as Ticket
    const tool = ticketCodexTool(ticket)
    expect(tool.name).toBe('orchestrator_codex')
    const args = tool.schema.parse({ task: 'Update the README document' })
    expect(args).toMatchObject({ mode: 'write' })
    expect(() => tool.schema.parse({ task: 'x', directory: '/private' })).toThrow()
    expect(tool.description).toContain('THIS Ticket worktree')
  })
  it('does not invent token metrics', () => {
    expect(reportedCodexTokens('tokens used\n15,001\n')).toBe(15001)
    expect(reportedCodexTokens('no metric')).toBeUndefined()
  })
})
