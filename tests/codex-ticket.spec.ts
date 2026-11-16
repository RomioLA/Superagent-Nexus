import { describe, expect, it } from 'vitest'
import { codexCliArgs, reportedCodexTokens, ticketCodexTool } from '../src/app/tools/codex.ts'
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
  it('selects each call model through CLI arguments', () => {
    const args = codexCliArgs({ mode: 'write', model: 'gpt-6-luna' }, '/tmp/w', '/tmp/o')
    expect(args).toEqual(['exec', '-C', '/tmp/w', '--sandbox', 'workspace-write', '--ephemeral',
      '--model', 'gpt-6-luna', '-c', 'model_reasoning_effort="medium"', '-o', '/tmp/o', '-'])
    expect(args.join(' ')).not.toContain('config.toml')
    expect(codexCliArgs({ mode: 'write' }, '/tmp/w', '/tmp/o')).not.toContain('--model')
    const other = codexCliArgs({ mode: 'write', model: 'gpt-6.1-sol' }, '/tmp/w', '/tmp/o')
    expect(other.slice(other.indexOf('--model'), other.indexOf('--model') + 2)).toEqual(['--model', 'gpt-6.1-sol'])
    expect(other).not.toEqual(args)
  })
  it('does not invent token metrics', () => {
    expect(reportedCodexTokens('tokens used\n15,001\n')).toBe(15001)
    expect(reportedCodexTokens('no metric')).toBeUndefined()
  })
  it('refuses to run without an explicit authorized model so the CLI default cannot bypass the whitelist', async () => {
    const ticket = { id: 't', execution: { directory: '/tmp/dsh-ticket', name: 't', assignment: '', harness: { harness: 'codex' } } } as Ticket
    await expect(ticketCodexTool(ticket).execute({ task: 'Make a change', mode: 'write' }, new AbortController().signal))
      .rejects.toThrow(/explicit authorized model/)
  })
})
