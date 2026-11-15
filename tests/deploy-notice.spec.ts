import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEPLOY_STALL_MS, deployObservation, deployWatchExpired, readDeployObservation } from '../src/executor/deploy.ts'

const state = { step: 'rolled_back', status: 'success', at: '2026-11-14T12:00:00Z',
  new: '/releases/deploy-1', old: '/releases/deploy-0', detail: 'acceptance failed' }

describe('deployment observations', () => {
  it.each([
    ['rolled_back', 'success', 'rolled_back'],
    ['rolled_back', 'failure', 'rollback_failed'],
    ['aborted', 'failure', 'aborted'],
    ['complete', 'success', 'succeeded'],
  ])('maps %s/%s to %s using the deployment release as identity', (step, status, result) => {
    expect(deployObservation({ ...state, step, status })).toEqual({ phase: 'settled',
      notice: { eventId: state.new, result, detail: state.detail } })
  })

  it.each(['precheck', 'backup', 'switched', 'restarting', 'healthy_ok', 'acceptance', 'already_new', 'rolling_back'])(
    'keeps %s pending without a notice', step => {
      for (const status of ['running', 'failure', 'success']) {
        expect(deployObservation({ ...state, step, status })).toEqual({ phase: 'pending', eventId: state.new, at: state.at })
      }
    })

  it.each(['failure', 'running', '', undefined, null])('ignores complete with non-success status %s', status => {
    expect(deployObservation({ ...state, step: 'complete', status })).toEqual({ phase: 'none' })
  })

  it.each([null, undefined, [], 'complete', 1, true])('ignores non-object state %s', value => {
    expect(deployObservation(value)).toEqual({ phase: 'none' })
  })

  it.each([undefined, '', '   ', 1, null])('rejects missing or empty deployment identity %s', value => {
    expect(deployObservation({ ...state, new: value })).toEqual({ phase: 'none' })
  })

  it('ignores unrecognized steps', () => {
    expect(deployObservation({ ...state, step: 'unknown' })).toEqual({ phase: 'none' })
  })

  it('prefers a trimmed per-run identity so repeated deployments of one release stay distinct', () => {
    const first = deployObservation({ ...state, run: ' run-1 ' })
    const second = deployObservation({ ...state, run: 'run-2' })
    expect(first).toMatchObject({ phase: 'settled', notice: { eventId: 'run-1' } })
    expect(second).toMatchObject({ phase: 'settled', notice: { eventId: 'run-2' } })
    expect(first).not.toEqual(second)
    expect(deployObservation({ ...state, step: 'precheck', run: ' run-1 ' }))
      .toEqual({ phase: 'pending', eventId: 'run-1', at: state.at })
  })

  it.each([undefined, '', '   ', 1, null])('falls back to the release path for unusable run %s', run => {
    expect(deployObservation({ ...state, run })).toMatchObject({ phase: 'settled', notice: { eventId: state.new } })
  })

  it.each(['2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z', 'invalid', undefined])(
    'does not filter by timestamp %s', at => {
      expect(deployObservation({ ...state, at })).toEqual(deployObservation(state))
    })

  it('limits detail to 160 characters, stringifies it and defaults absent detail to empty', () => {
    for (const [detail, expected] of [['x'.repeat(200), 'x'.repeat(160)], [undefined, ''], [null, ''], [123, '123']]) {
      expect(deployObservation({ ...state, detail })).toEqual({ phase: 'settled',
        notice: { eventId: state.new, result: 'rolled_back', detail: expected } })
    }
  })
})

describe('reading a ticket deployment observation', () => {
  it('reads only the given directory and distinguishes missing from malformed files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-notice-'))
    const other = mkdtempSync(join(tmpdir(), 'deploy-notice-other-'))
    try {
      expect(readDeployObservation(undefined)).toEqual({ phase: 'none' })
      expect(readDeployObservation(directory)).toEqual({ phase: 'none' })
      writeFileSync(join(directory, 'DEPLOY_STATE.json'), '{bad json')
      expect(readDeployObservation(directory)).toEqual({ phase: 'unreadable' })
      writeFileSync(join(directory, 'DEPLOY_STATE.json'), JSON.stringify(state))
      expect(readDeployObservation(directory)).toEqual(deployObservation(state))
      expect(readDeployObservation(other)).toEqual({ phase: 'none' })
      expect(readDeployObservation(join(directory, 'DEPLOY_STATE.json'))).toEqual({ phase: 'none' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('treats a state file that is a directory as unreadable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-unreadable-'))
    try {
      mkdirSync(join(directory, 'DEPLOY_STATE.json'))
      expect(readDeployObservation(directory)).toEqual({ phase: 'unreadable' })
      expect(readDeployObservation(join(directory, 'missing'))).toEqual({ phase: 'none' })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

describe('deployment progress expiry', () => {
  const now = Date.parse(state.at)
  it.each([0, DEPLOY_STALL_MS, DEPLOY_STALL_MS + 1])('expires only after the stall window (%s ms)', age => {
    const observation = deployObservation({ ...state, step: 'acceptance', at: new Date(now - age).toISOString() })
    if (observation.phase !== 'pending') throw new Error('Expected pending deployment')
    expect(deployWatchExpired(observation, now)).toBe(age > DEPLOY_STALL_MS)
  })

  it.each([undefined, '', 'invalid', null, 123])('expires pending state with unusable at %s', at => {
    const observation = deployObservation({ ...state, step: 'acceptance', at })
    if (observation.phase !== 'pending') throw new Error('Expected pending deployment')
    expect(deployWatchExpired(observation, now)).toBe(true)
  })
})
