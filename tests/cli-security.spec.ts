import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliStateDir, ensureCliDir, reuseCredential } from '../src/app/tools/cli-isolation.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cli-security-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('CLI state and credential path checks', () => {
  it('rejects Ticket IDs that can escape the per-Ticket state directory', () => {
    expect(() => cliStateDir('/tickets/fix-one', '../../outside')).toThrow('Invalid Ticket ID')
    expect(() => cliStateDir('/tickets/fix-one', 'nested/ticket')).toThrow('Invalid Ticket ID')
    expect(cliStateDir('/tickets/fix-one', 'ticket-one_2')).toBe('/tickets/.dsh-cli/ticket-one_2')
  })

  it('refuses a state directory whose path traverses a symlink', async () => {
    const real = join(dir, 'real')
    await mkdir(real)
    const alias = join(dir, 'alias')
    await symlink(real, alias)
    await expect(ensureCliDir(join(alias, 'ticket'))).rejects.toThrow('symlink')
  })

  it('does not accept an existing credential link to another target', async () => {
    const shared = join(dir, 'shared')
    const other = join(dir, 'other')
    const home = join(dir, 'home')
    await mkdir(shared)
    await mkdir(home)
    await writeFile(join(shared, 'auth'), 'credential')
    await writeFile(other, 'synthetic')
    await symlink(other, join(home, 'auth'))
    await expect(reuseCredential(join(shared, 'auth'), join(home, 'auth'))).rejects.toThrow('unexpected target')
    expect(await readlink(join(home, 'auth'))).toBe(other)
  })

  it('handles concurrent Ticket home preparation without accepting a foreign link', async () => {
    const target = join(dir, 'token')
    const link = join(dir, 'private', 'token')
    await writeFile(target, 'synthetic credential')
    await ensureCliDir(join(dir, 'private'))
    await Promise.all([reuseCredential(target, link), reuseCredential(target, link)])
    expect(await readlink(link)).toBe(target)
  })
})
