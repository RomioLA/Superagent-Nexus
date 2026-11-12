/** The Harness instructions a worker receives must state the same fallback rule the executor enforces. */
import { expect, it } from 'vitest'
import { harnessInstructions } from '../src/executor/dsh.ts'

it('states the enforced fallback rule when allowFallback is omitted or false, and permits it only when true', () => {
  // HarnessSpec: an omitted allowFallback means no silent substitution, and the delegate guard rejects a different
  // Harness unless allowFallback === true. The prompt must say the same, including for the common omitted case.
  for (const harness of [{ harness: 'agy', model: '3.8f' }, { harness: 'agy', model: '3.8f', allowFallback: false }] as const) {
    const text = harnessInstructions(harness)
    expect(text).toContain('Do not fall back to a different Harness on failure')
    expect(text).not.toContain('A documented fallback is allowed')
  }
  const allowed = harnessInstructions({ harness: 'agy', model: '3.8f', allowFallback: true })
  expect(allowed).toContain('A documented fallback is allowed if the preferred Harness is unavailable')
  expect(allowed).not.toContain('Do not fall back to a different Harness on failure')
})

it('never tells a DSH-native worker both not to delegate and that a fallback is allowed', () => {
  const strict = harnessInstructions({ harness: 'dsh' })
  expect(strict).toContain('do not delegate this work to AGY, Codex or Grok')
  expect(strict).toContain('Do not fall back to a different Harness on failure')
  const fallback = harnessInstructions({ harness: 'dsh', allowFallback: true })
  expect(fallback).not.toContain('do not delegate this work to AGY, Codex or Grok')
  expect(fallback).toContain('A documented fallback is allowed')
})

it('keeps the explicit model and forbid4a constraints in the assignment text', () => {
  const text = harnessInstructions({ harness: 'agy', model: '3.8f', forbid4a: true })
  expect(text).toContain('(model=3.8f)')
  expect(text).toContain('Do not use model=4a for any reason')
})
