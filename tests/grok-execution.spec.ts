import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { grokArgs, runTicketGrok, ticketGrokTool } from '../src/app/tools/grok.ts'
import type { Ticket } from '../src/core/index.ts'
import { gitEnv } from './fixtures/git.ts'

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }))
const git = promisify(execFile)
const modelUsage = { 'grok-4.7-build-fast': { modelCalls: 1, totalTokens: 152, costUSD: 0.0008 } }
const end = { type: 'end', stopReason: 'end_turn', modelUsage }
const edit = [{ type: 'tool_call', toolCallId: 'edit-1', toolName: 'search_replace' },
  { type: 'tool_call_update', toolCallId: 'edit-1', status: 'completed' }]
const stream = (events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n'
let root: string, workspace: string
let outcome: (args: string[]) => Promise<{ events?: unknown[]; json?: unknown; exit?: number; hold?: boolean }>
let kill: ReturnType<typeof vi.spyOn>
const started = () => Promise.withResolvers<void>()
let taskStarted: ReturnType<typeof started>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'grok-execution-'))
  workspace = join(root, 'ticket')
  await mkdir(workspace)
  await git('git', ['init', '-q'], { cwd: workspace, env: gitEnv() })
  await writeFile(join(workspace, 'existing.txt'), 'before')
  // Deliberately dirty before Grok: pre-existing changes must not count as this run's writes.
  await git('git', ['add', 'existing.txt'], { cwd: workspace, env: gitEnv() })
  await writeFile(join(workspace, 'existing.txt'), 'pre-existing dirty change')
  taskStarted = started()
  outcome = async () => ({ events: [{ type: 'text', data: 'Created target.txt.' }, end] })
  vi.mocked(spawn).mockReset()
  vi.mocked(spawn).mockImplementation(((_program: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
      pid: 2147483000, kill: vi.fn(() => true) })
    kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true
    })
    queueMicrotask(async () => {
      if (args.includes('version')) {
        child.stdout.write('grok 1.0.80 (test)\n'); child.emit('close', 0, null); return
      }
      taskStarted.resolve()
      const response = await outcome(args)
      if (response.events) child.stdout.write(stream(response.events))
      if (response.json) child.stdout.write(JSON.stringify(response.json))
      if (!response.hold) child.emit('close', response.exit ?? 0, null)
    })
    return child
  }) as unknown as typeof spawn)
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
const ticketTool = (control: Parameters<typeof ticketGrokTool>[1] = {}) => {
  const tool = ticketGrokTool({ id: 'ticket-one', execution: { directory: workspace } } as Ticket, control)
  return { ...tool, execute: (raw: unknown, signal: AbortSignal) => tool.execute(grokArgs.parse(raw), signal) }
}
const args = { task: 'Create the target file' }
const modelRuns = () => vi.mocked(spawn).mock.calls.filter(([, argv]) => (argv as string[]).includes('-p'))

describe('bounded Grok execution without real model calls', () => {
  it.each([0, 1])('reports native max-turn exhaustion at exit %s, then refuses automatic repeats and limit escalation', async exit => {
    outcome = async argv => {
      const limit = Number(argv[argv.indexOf('--max-turns') + 1])
      expect(limit).toBe(12)
      return { exit, events: [...Array.from({ length: limit }, (_, index) => ({ type: 'tool_call', toolCallId: String(index), toolName: 'read_file' })),
        { type: 'max_turns_reached' }, { ...end, stopReason: 'max_turns_reached' }] }
    }
    const tool = ticketTool()
    await expect(tool.execute(args, new AbortController().signal)).rejects.toThrow(/max_turns.*no automatic retry/)
    await expect(tool.execute({ ...args, max_turns: 50, limit_reason: 'Try the failed task again' }, new AbortController().signal))
      .rejects.toThrow('Grok is stopped for this Assignment')
    expect(modelRuns()).toHaveLength(1)
  })

  it('rejects a claimed write without file changes and never starts another run after failure', async () => {
    const tool = ticketTool()
    await expect(tool.execute(args, new AbortController().signal)).rejects.toThrow('0 changed files, 0 completed edit calls')
    await expect(readFile(join(workspace, 'target.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(tool.execute(args, new AbortController().signal)).rejects.toThrow('explicit Ticket retry')
    expect(modelRuns()).toHaveLength(1)
  })

  it('rejects completed edit events when the workspace did not change', async () => {
    outcome = async () => ({ events: [...edit, { type: 'text', data: 'Updated the file.' }, end] })
    await expect(ticketTool().execute(args, new AbortController().signal)).rejects.toThrow('0 changed files, 1 completed edit calls')
  })

  it('rejects concurrent workspace changes without a completed Grok edit', async () => {
    outcome = async () => { await writeFile(join(workspace, 'target.txt'), 'external'); return { events: [{ type: 'text', data: 'Done' }, end] } }
    await expect(ticketTool().execute(args, new AbortController().signal)).rejects.toThrow('1 changed files, 0 completed edit calls')
  })

  it.each(['existing.txt', 'target.txt'])('accepts a simple %s edit once with tool and new workspace evidence', async file => {
    outcome = async () => { await writeFile(join(workspace, file), 'actual edit'); return { events: [...edit, { type: 'text', data: 'Edited the file.' }, end] } }
    vi.stubEnv('XAI_API_KEY', 'synthetic-do-not-inherit')
    const result = await ticketTool().execute(args, new AbortController().signal)
    expect(result).toMatchObject({ status: 'finished', write_evidence: { changedFiles: 1, completedEditCalls: 1 } })
    expect(modelRuns()).toHaveLength(1)
    expect(await readFile(join(workspace, file), 'utf8')).toBe('actual edit')
    expect(modelRuns()[0]![2]?.env).not.toHaveProperty('XAI_API_KEY')
  })

  it('preserves read-only completion without inventing write evidence', async () => {
    outcome = async () => ({ json: { text: 'Inspected the file.', stopReason: 'end_turn', modelUsage } })
    const result = await runTicketGrok(workspace, 'ticket-one', 'Inspect the file', { mode: 'read-only' }, new AbortController().signal)
    expect(result.summary).toBe('Inspected the file.')
    expect(result).not.toHaveProperty('write_evidence')
    expect(modelRuns()).toHaveLength(1)
  })

  it('keeps a bounded larger initial run available only with a complexity reason', async () => {
    expect(() => grokArgs.parse({ ...args, max_turns: 24 })).toThrow('requires limit_reason')
    expect(() => grokArgs.parse({ ...args, max_turns: 51, limit_reason: 'Complex migration' })).toThrow()
    outcome = async argv => {
      expect(argv[argv.indexOf('--max-turns') + 1]).toBe('24')
      return { json: { text: 'Inspected.', stopReason: 'end_turn', modelUsage } }
    }
    await ticketTool().execute({ ...args, mode: 'read-only', max_turns: 24, limit_reason: 'Inspect a multi-module migration' }, new AbortController().signal)
    expect(modelRuns()).toHaveLength(1)
  })

  it('allows an explicit new Assignment to run through the same persistent tool binding', async () => {
    let assignment = 'first'
    const tool = ticketTool({ assignmentId: () => assignment })
    await expect(tool.execute(args, new AbortController().signal)).rejects.toThrow('write is unverified')
    await expect(tool.execute(args, new AbortController().signal)).rejects.toThrow('Grok is stopped')
    assignment = 'explicit-retry'
    outcome = async () => { await writeFile(join(workspace, 'target.txt'), 'actual'); return { events: [...edit, { type: 'text', data: 'Edited.' }, end] } }
    await expect(tool.execute(args, new AbortController().signal)).resolves.toMatchObject({ status: 'finished' })
    expect(modelRuns()).toHaveLength(2)
  })

  it('still cancels the isolated process group and rejects the partial result', async () => {
    outcome = async () => ({ hold: true, events: [{ type: 'usage', signature: { input_tokens: 120 } }] })
    const controller = new AbortController()
    const run = ticketTool().execute(args, controller.signal)
    const rejected = expect(run).rejects.toThrow('Grok cancelled')
    await taskStarted.promise
    controller.abort()
    await rejected
    expect(kill).toHaveBeenCalledWith(-2147483000, 'SIGTERM')
    expect(modelRuns()).toHaveLength(1)
  })
})
