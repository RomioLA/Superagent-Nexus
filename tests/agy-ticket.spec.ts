import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agyArgs, agyCliArgs, agyDependencyReadPath, nativeAgyModel, parseAgyOutput, runTicketAgy, ticketAgyTool } from '../src/app/tools/agy.ts'
import { cliStateDir } from '../src/app/tools/cli-isolation.ts'
import type { Ticket } from '../src/core/index.ts'

const live = process.env.AGY_LIVE_SMOKE === '1' ? it : it.skip
async function createMinimalGitRepo(directory: string): Promise<void> {
  const git = join(directory, '.git')
  await mkdir(join(git, 'refs', 'heads'), { recursive: true })
  await mkdir(join(git, 'objects', 'info'), { recursive: true })
  await mkdir(join(git, 'objects', 'pack'), { recursive: true })
  await writeFile(join(git, 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(git, 'config'), '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n')
}

live('calls native AGY 3.8F with the real Ticket workspace and a read-only prompt', async () => {
  const root = await mkdtemp(join(process.cwd(), '.agy-live-read-'))
  const workspace = join(root, 'workspace')
  const ticketId = `live-${basename(root).replace(/[^A-Za-z0-9_-]/g, '')}`
  try {
    await mkdir(workspace)
    await createMinimalGitRepo(workspace)
    const result = await runTicketAgy(workspace, ticketId, {
      task: 'Respond exactly AGY_WORKER_TOOL_OK; do not use tools or inspect files.',
      model: '3.8f', mode: 'read-only', reasoning: 'low',
    }, new AbortController().signal)
    expect(result.harness).toBe('antigravity')
    expect(result.requested_model).toBe('gemini-3.8-flash-low')
    expect(result.summary).toContain('AGY_WORKER_TOOL_OK')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120000)

live('edits a temporary Ticket, runs Node and Git, runs project tests, and cannot read outside credentials', async () => {
  const root = await mkdtemp(join(process.cwd(), '.agy-live-write-'))
  const dir = join(root, 'workspace')
  const ticketId = `live-${basename(root).replace(/[^A-Za-z0-9_-]/g, '')}`
  const outsideFile = join(root, 'outside-sentinel.txt')
  try {
    await mkdir(join(dir, 'tests'), { recursive: true })
    await cp(join(process.cwd(), 'src'), join(dir, 'src'), { recursive: true })
    for (const file of ['agy-ticket.spec.ts', 'cli-isolation.spec.ts', 'cli-security.spec.ts'])
      await cp(join(process.cwd(), 'tests', file), join(dir, 'tests', file))
    for (const file of ['package.json', 'tsconfig.json', 'vitest.config.ts']) await cp(join(process.cwd(), file), join(dir, file))
    await symlink(await realpath(join(process.cwd(), 'node_modules')), join(dir, 'node_modules'), 'dir')
    await createMinimalGitRepo(dir)
    await writeFile(outsideFile, 'outside workspace sentinel')
    const isolatedHome = join(cliStateDir(dir, ticketId), 'home')
    const ticketToken = join(isolatedHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    const sharedToken = join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    await writeFile(join(dir, 'tests', 'agy-sandbox-boundary.spec.ts'), `
import { access } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
const paths = ${JSON.stringify([outsideFile, ticketToken, sharedToken])}
it('cannot read a sibling workspace file or either AGY credential path', async () => {
  for (const path of paths) await expect(access(path, constants.R_OK)).rejects.toBeDefined()
  await expect(writeFile(paths[0], 'outside access')).rejects.toBeDefined()
  await writeFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'agy-sandbox-boundary.proof'), 'PASS')
})
`)
    const result = await runTicketAgy(dir, ticketId, {
      task: [
        'Create hello.txt containing exactly "hello\\n".',
        'Run these allowed commands and no others: `node --version`, `git --version`, and `git status --short`.',
        'Run this project test command: `./node_modules/.bin/vitest run tests/agy-ticket.spec.ts tests/cli-isolation.spec.ts tests/cli-security.spec.ts tests/agy-sandbox-boundary.spec.ts --configLoader runner`.',
        'Do not read or print any file outside this Ticket workspace. The boundary test checks that access is denied.',
        'Report each command and the test summary.',
      ].join(' '),
      model: '3.8f', mode: 'write', reasoning: 'low',
    }, new AbortController().signal)
    expect(result.harness).toBe('antigravity')
    expect(result.summary.length).toBeGreaterThan(0)
    expect(await readFile(join(dir, 'hello.txt'), 'utf8')).toBe('hello\n')
    let proof: string
    try { proof = await readFile(join(dir, 'agy-sandbox-boundary.proof'), 'utf8') }
    catch (error) { throw new Error(`AGY did not complete the boundary test. Summary: ${result.summary}`, { cause: error }) }
    expect(proof).toBe('PASS')
    expect(await readFile(outsideFile, 'utf8')).toBe('outside workspace sentinel')
    expect(result.summary).toContain('node --version')
    expect(result.summary).toContain('git --version')
    expect(result.summary).toContain('git status --short')
    expect(result.summary).toContain('vitest')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 300000)

describe('AGY uses the existing native Ticket Executor', () => {
  const ticket = { id: 'ticket', execution: { directory: '/tmp/dsh-ticket', name: 'ticket', assignment: '' } } as Ticket
  it('provides a worktree-scoped tool with explicit model selection', () => {
    const tool = ticketAgyTool(ticket)
    expect(tool.name).toBe('orchestrator_agy')
    expect(() => tool.schema.parse({ task: 'Change the README' })).toThrow()
    expect(tool.schema.parse({ task: 'Change the README', model: '3.8f' }))
      .toMatchObject({ mode: 'write', reasoning: 'medium' })
    expect(() => tool.schema.parse({ task: 'Change the README', model: '3.8f', directory: '/private' })).toThrow()
    expect(tool.description).toContain('THIS Ticket worktree')
  })
  it('maps both account models to the exact native CLI model IDs', () => {
    expect(nativeAgyModel(agyArgs.parse({ task: 'Read repository files', model: '4a', reasoning: 'high' })))
      .toBe('gemini-4-argon-high')
    expect(nativeAgyModel(agyArgs.parse({ task: 'Read repository files', model: '3.8f', reasoning: 'medium' })))
      .toBe('gemini-3.8-flash-medium')
  })
  it('uses normal sandbox permissions for accept-edits writes and plan reads', () => {
    const write = agyCliArgs(agyArgs.parse({ task: 'Change the README', model: '3.8f' }), 'prompt', '/tmp/ticket-worktree', '/tmp/agy.log')
    expect(write).toContain('--mode')
    expect(write[write.indexOf('--mode') + 1]).toBe('accept-edits')
    expect(write).not.toContain('--dangerously-skip-permissions')
    expect(write).toContain('--sandbox')
    expect(write.slice(write.indexOf('--add-dir'), write.indexOf('--add-dir') + 2)).toEqual(['--add-dir', '/tmp/ticket-worktree'])
    expect(write).not.toContain('--settings')
    const read = agyCliArgs(agyArgs.parse({ task: 'Read the README', model: '3.8f', mode: 'read-only' }), 'prompt', '/tmp/ticket-worktree')
    expect(read[read.indexOf('--mode') + 1]).toBe('plan')
    expect(read).not.toContain('--dangerously-skip-permissions')
  })
  it('exposes only the DSH runtime dependency directory when a Ticket links node_modules outside itself', async () => {
    const root = await mkdtemp(join(process.cwd(), '.agy-dependencies-'))
    const workspace = join(root, 'workspace')
    const runtimeDependencies = join(root, 'runtime-node_modules')
    const foreignDependencies = join(root, 'foreign-node_modules')
    try {
      await mkdir(workspace)
      await mkdir(runtimeDependencies)
      await mkdir(foreignDependencies)
      await symlink(runtimeDependencies, join(workspace, 'node_modules'), 'dir')
      expect(await agyDependencyReadPath(workspace, runtimeDependencies)).toBe(runtimeDependencies)
      await rm(join(workspace, 'node_modules'))
      await symlink(foreignDependencies, join(workspace, 'node_modules'), 'dir')
      expect(await agyDependencyReadPath(workspace, runtimeDependencies)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('accepts real JSON response fields without inventing usage', () => {
    expect(parseAgyOutput(JSON.stringify({ status: 'SUCCESS', response: 'Done', duration_seconds: 7.5 })))
      .toEqual({ summary: 'Done', duration_seconds: 7.5 })
  })
  it('keeps native AGY failures visible to the DSH Executor', () => {
    const tool = ticketAgyTool({ id: 't', execution: { directory: '/tmp/t', name: 't', assignment: '' } } as Ticket)
    expect(tool.description).toContain('repeatedly retry model errors')
  })
  it('identifies print timeouts, error objects and stderr AGY_ERROR reasons', () => {
    expect(() => parseAgyOutput(JSON.stringify({ status: 'ERROR', error: 'invalid model selection' }))).toThrow('AGY failed: invalid model selection')
    expect(() => parseAgyOutput(JSON.stringify({ status: 'ERROR', error: { short_error: 'permission denied' } }))).toThrow('AGY failed: permission denied')
    expect(() => parseAgyOutput(JSON.stringify({ status: 'ERROR', response: '', finished_reason: 'print_timeout' }))).toThrow('print timeout')
    // A status that looks successful but whose stderr carries a deadline error still fails, never claims success.
    const stderr = 'AGY_ERROR: {"short_error":"print timeout after 450s","status":"DEADLINE_EXCEEDED","reason":"print_timeout"}'
    expect(() => parseAgyOutput(JSON.stringify({ status: 'SUCCESS', response: '' }), stderr)).toThrow('print timeout')
  })
  it('rejects empty and malformed results rather than claiming success', () => {
    expect(() => parseAgyOutput(JSON.stringify({ status: 'SUCCESS', response: '', num_turns: 0 }))).toThrow('no final response')
    expect(() => parseAgyOutput(JSON.stringify({ status: 'SUCCESS', response: '', num_turns: 3 }))).toThrow('unconfirmed')
    expect(() => parseAgyOutput('not json')).toThrow('valid JSON')
  })
})
