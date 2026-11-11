import { describe, expect, it } from 'vitest'
import { diagnoseGrokStream, grokArgs, grokCliArgs, isGrokAuthFailure, parseGrokOutput, parseGrokStreamingOutput, ticketGrokTool } from '../src/app/tools/grok.ts'
import type { Ticket } from '../src/core/index.ts'

describe('Grok Build is a native Executor CLI tool', () => {
  it('exposes a worktree-scoped tool with a fixed native model and mode default', () => {
    const ticket = { id: 'ticket', execution: { directory: '/tmp/dsh-ticket', name: 'ticket', assignment: '' } } as Ticket
    const tool = ticketGrokTool(ticket)
    expect(tool.name).toBe('orchestrator_grok')
    expect(grokArgs.parse({ task: 'Update the README document' })).toMatchObject({ mode: 'write' })
    expect(() => grokArgs.parse({ task: 'Read the README', model: 'other-model' })).toThrow()
    expect(() => grokArgs.parse({ task: 'Read the README', directory: '/private' })).toThrow()
    expect(tool.description).toContain('Ticket worktree')
    expect(tool.description).toContain('No fallback')
  })

  it('uses official streaming JSON with ticket-scoped file tools and fail-closed permissions for writes', () => {
    const write = grokCliArgs(grokArgs.parse({ task: 'Change one source file' }), 'prompt', '/tickets/one')
    expect(write.slice(write.indexOf('--cwd'), write.indexOf('--cwd') + 2)).toEqual(['--cwd', '/tickets/one'])
    expect(write.slice(write.indexOf('--model'), write.indexOf('--model') + 2)).toEqual(['--model', 'grok-4.7-build-fast'])
    expect(write.slice(write.indexOf('--output-format'), write.indexOf('--output-format') + 2)).toEqual(['--output-format', 'streaming-json'])
    expect(write.slice(write.indexOf('--sandbox'), write.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'dsh-ticket'])
    expect(write.slice(write.indexOf('--permission-mode'), write.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'dontAsk'])
    expect(write.slice(write.indexOf('--tools'), write.indexOf('--tools') + 2)[1]).toBe('read_file,grep,search_replace')
    expect(write).toContain('Read(/tickets/one/**)')
    expect(write).toContain('Grep(/tickets/one/**)')
    expect(write).toContain('Edit(/tickets/one/**)')
    expect(write).not.toContain('list_dir')
    expect(write).not.toContain('grep_search')
    expect(write.some(value => value.startsWith('Bash('))).toBe(false)
    expect(write).toContain('Read(**/.env*)')
    expect(write).not.toContain('memory_search')
    expect(() => grokCliArgs(grokArgs.parse({ task: 'Change one source file' }), 'prompt', '/tickets/unsafe*(x)'))
      .toThrow('cannot be safely represented')
    expect(write).toContain('--deny')
    expect(write).not.toContain('--always-approve')

    const read = grokCliArgs(grokArgs.parse({ task: 'Inspect the README', mode: 'read-only' }), 'prompt', '/tickets/one')
    expect(read.slice(read.indexOf('--sandbox'), read.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only'])
    expect(read.slice(read.indexOf('--tools'), read.indexOf('--tools') + 2)[1]).toBe('read_file,grep,list_dir')
    expect(read).not.toContain('search_replace,run_terminal_cmd')
    expect(read.some(value => value.startsWith('Bash('))).toBe(false)
  })

  it('accepts documented JSON only when it records a completed Grok model call', () => {
    const output = JSON.stringify({
      text: 'Read the requested file and summarized it.',
      stopReason: 'end_turn',
      sessionId: 'session-123',
      requestId: 'request-456',
      num_turns: 1,
      usage: { input_tokens: 120, output_tokens: 32, total_tokens: 152 },
      total_cost_usd: 0.0008,
      modelUsage: {
        'grok-4.7-build-fast': { inputTokens: 120, outputTokens: 32, modelCalls: 1, costUSD: 0.0008 },
      },
    })
    expect(parseGrokOutput(output)).toEqual({
      summary: 'Read the requested file and summarized it.',
      requested_model: 'grok-4.7-build-fast',
      models: ['grok-4.7-build-fast'],
      session_id: 'session-123',
      request_id: 'request-456',
      usage: { inputTokens: 120, outputTokens: 32, totalTokens: 152, modelCalls: 1, costUSD: 0.0008 },
    })
  })

  it('parses streaming-json completion events and records tool metadata without event contents', () => {
    const output = [
      { type: 'available_commands', tools: ['GrokBuild:read_file', 'GrokBuild:grep', 'GrokBuild:search_replace'] },
      { type: 'tool_call', toolCallId: 'tool-1', toolName: 'search_replace', status: 'in_progress',
        rawInput: { path: '/private/secret.txt', old_string: 'SENSITIVE_CONTENT' } },
      { type: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress', content: [] },
      { type: 'tool_call_update', toolCallId: 'tool-1', status: 'completed',
        rawOutput: { result: 'SENSITIVE_CONTENT' } },
      { type: 'text', data: 'Updated the acceptance marker.' },
      { type: 'usage', signature: { input_tokens: 120, output_tokens: 32 } },
      { type: 'end', stopReason: 'end_turn', sessionId: 'session-123', requestId: 'request-456',
        modelUsage: { 'grok-4.7-build-fast': { inputTokens: 120, outputTokens: 32, totalTokens: 152, modelCalls: 1, costUSD: 0.0008 } },
        total_cost_usd: 0.0008 },
    ].map(event => JSON.stringify(event)).join('\n') + '\n'
    const parsed = parseGrokStreamingOutput(output)
    expect(parsed).toMatchObject({ summary: 'Updated the acceptance marker.', requested_model: 'grok-4.7-build-fast',
      session_id: 'session-123', request_id: 'request-456', usage: { totalTokens: 152, costUSD: 0.0008 },
      diagnostics: { phase: 'completed', availableTools: ['grep', 'read_file', 'search_replace'],
        toolCalls: [{ tool: 'search_replace', status: 'completed' }] } })
    expect(JSON.stringify(parsed.diagnostics)).not.toContain('secret.txt')
    expect(JSON.stringify(parsed.diagnostics)).not.toContain('SENSITIVE_CONTENT')
  })

  it('diagnoses permission denial and a tool call left pending without retaining arguments', () => {
    expect(diagnoseGrokStream(JSON.stringify({ type: 'error', message: "Couldn't set model; unknown model id" })))
      .toMatchObject({ phase: 'model_error', eventTypes: ['error'] })

    const denied = diagnoseGrokStream(JSON.stringify({ type: 'permission_denied', tool_name: 'search_replace',
      reason: 'Edit denied for /private/secret.txt' }))
    expect(denied).toMatchObject({ phase: 'permission_denied', toolCalls: [{ tool: 'search_replace', status: 'permission_denied' }] })
    expect(JSON.stringify(denied)).not.toContain('secret.txt')

    const pending = diagnoseGrokStream(JSON.stringify({ type: 'tool_call', toolCallId: 'tool-2', toolName: 'search_replace', status: 'in_progress',
      rawInput: { path: '/private/secret.txt', new_string: 'SENSITIVE_CONTENT' } }))
    expect(pending).toMatchObject({ phase: 'tool_execution_pending', toolCalls: [{ tool: 'search_replace', status: 'requested' }] })
    expect(JSON.stringify(pending)).not.toContain('secret.txt')
    expect(JSON.stringify(pending)).not.toContain('SENSITIVE_CONTENT')
  })

  it('rejects chat text, incomplete turns, errors and output without Grok model usage', () => {
    expect(() => parseGrokOutput('I am Grok and I completed the change.')).toThrow('valid JSON')
    expect(() => parseGrokOutput(JSON.stringify({
      text: 'Completed', stopReason: 'max_turns_reached',
      modelUsage: { 'grok-4.7-build-fast': { modelCalls: 1 } },
    }))).toThrow('did not complete the turn')
    expect(() => parseGrokOutput(JSON.stringify({
      type: 'error', message: 'login required',
    }))).toThrow('error result')
    expect(() => parseGrokOutput(JSON.stringify({
      text: 'Completed', stopReason: 'end_turn',
      modelUsage: { 'other-provider-model': { modelCalls: 1 } },
    }))).toThrow('execution is unverified')
    expect(() => parseGrokOutput(JSON.stringify({
      text: 'Completed', stopReason: 'end_turn',
      modelUsage: { 'grok-4.7': { modelCalls: 1 } },
    }))).toThrow('did not report the requested model grok-4.7-build-fast')
    expect(() => parseGrokOutput(JSON.stringify({
      text: 'Completed', stopReason: 'end_turn',
      modelUsage: { 'grok-4.7-build-fast': { modelCalls: 0 } },
    }))).toThrow('execution is unverified')
  })

  it('does not invent missing usage fields', () => {
    expect(parseGrokOutput(JSON.stringify({
      text: 'Done', stopReason: 'end_turn',
      modelUsage: { 'grok-4.7-build-fast': { modelCalls: 1 } },
    }))).toEqual({
      summary: 'Done', requested_model: 'grok-4.7-build-fast', models: ['grok-4.7-build-fast'], usage: { modelCalls: 1 },
    })
  })

  it('recognizes the CLI not-signed-in error without exposing raw authentication output', () => {
    expect(isGrokAuthFailure('Not signed in. To authenticate without a browser, run grok login --device-code.')).toBe(true)
    expect(isGrokAuthFailure('unrecognized option --example')).toBe(false)
  })
})
