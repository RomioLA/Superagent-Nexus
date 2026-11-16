import { describe, expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { buildDirectTask, directHarnessOf, parseWorkerReport, reportOutcome, WORKER_REPORT_MARKER } from '../src/executor/direct.ts'
import { runDirectWorker } from '../src/executor/direct-runner.ts'

const ticket = (partial: Partial<Ticket>): Ticket => ({ ...partial }) as unknown as Ticket

describe('directHarnessOf', () => {
  it('selects external Harness tickets only', () => {
    expect(directHarnessOf(ticket({ execution: { name: 'x', directory: '/w', assignment: 'a', harness: { harness: 'dsh', model: 'm' } } }))).toBeUndefined()
    for (const harness of ['codex', 'grok', 'agy'] as const) {
      const spec = { harness, ...(harness === 'codex' ? { model: 'gpt-x' } : harness === 'agy' ? { model: '3.8f' } : {}) }
      expect(directHarnessOf(ticket({ execution: { name: 'x', directory: '/w', assignment: 'a', harness: spec } }))).toEqual(spec)
    }
  })
})

describe('parseWorkerReport', () => {
  it('parses the last valid marker line', () => {
    const text = 'did stuff\n' + WORKER_REPORT_MARKER + '{"state":"ready","summary":"done"}\nmore\n' + WORKER_REPORT_MARKER + '{"state":"blocked","summary":"need key"}'
    expect(parseWorkerReport(text)).toEqual({ state: 'blocked', summary: 'need key' })
  })
  it('ignores invalid states, empty summaries and missing markers', () => {
    expect(parseWorkerReport(WORKER_REPORT_MARKER + '{"state":"nope","summary":"x"}')).toBeUndefined()
    expect(parseWorkerReport('no marker here')).toBeUndefined()
    expect(parseWorkerReport(WORKER_REPORT_MARKER + '{"state":"ready","summary":"  "}')).toBeUndefined()
  })
})

describe('reportOutcome', () => {
  it('uses an explicit marker', () => {
    expect(reportOutcome({ status: 'finished', summary: 'x\n' + WORKER_REPORT_MARKER + '{"state":"ready","summary":"ok"}' }, 'write')).toEqual({ state: 'ready', summary: 'ok' })
  })
  it('never invents success without a marker', () => {
    expect(reportOutcome({ status: 'finished', summary: 'edited files' }, 'write')).toEqual({ state: 'progress', summary: 'edited files' })
    expect(reportOutcome({ status: 'limit_reached', summary: 'limit' }, 'write').state).toBe('progress')
    expect(reportOutcome({ status: 'failed', summary: 'boom' }, 'write').state).toBe('failed')
  })
})

describe('buildDirectTask', () => {
  it('transports the full original request, assignment and follow-ups', () => {
    const long = 'ORIGINAL-' + 'x'.repeat(5000)
    const t = ticket({ title: 'T', origin: { triggerId: 'trg1', triggerIds: ['trg1'] },
      inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'trg2', at: 'now' }, { id: 'i2', kind: 'text', text: 'FOLLOWUP-TEXT', at: 'now' }],
      execution: { name: 'x', directory: '/w', assignment: 'ASSIGNMENT-BODY' } })
    const store = { triggers: { get: (id: string) => id === 'trg1' ? { text: long } : id === 'trg2' ? { text: 'FOLLOWUP-TRIGGER' } : undefined } }
    const task = buildDirectTask(t, store)
    expect(task).toContain(long)
    expect(task).toContain('ASSIGNMENT-BODY')
    expect(task).toContain('FOLLOWUP-TRIGGER')
    expect(task).toContain('FOLLOWUP-TEXT')
    expect(task).toContain(WORKER_REPORT_MARKER)
  })
})

describe('runDirectWorker', () => {
  it('uses the injected runner and passes mode/task/ticket', async () => {
    const t = ticket({ id: 't1' })
    let seen: { ticketId?: string; mode?: string; task?: string } = {}
    const result = await runDirectWorker(t, '/w', 'TASK', { harness: 'grok' }, new AbortController().signal, async input => {
      seen = { ticketId: input.ticketId, mode: input.mode, task: input.task }
      return { status: 'finished', summary: 'ok' }
    })
    expect(result).toEqual({ status: 'finished', summary: 'ok' })
    expect(seen).toEqual({ ticketId: 't1', mode: 'write', task: 'TASK' })
  })
})
