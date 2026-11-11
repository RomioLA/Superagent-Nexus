import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliStateDir, prepareAgyHome, prepareCodexHome, prepareGrokHome, prepareGrokSandboxProfile, reuseCredential } from '../src/app/tools/cli-isolation.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cli-isolation-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('per-Ticket CLI isolation', () => {
  it('gives each Ticket its own state directory beside the workspace, never inside the checkout', () => {
    const one = cliStateDir('/tickets/fix-one-abcdef123456', 'ticket-one')
    const two = cliStateDir('/tickets/fix-two-abcdef123456', 'ticket-two')
    expect(one).toBe('/tickets/.dsh-cli/ticket-one')
    expect(two).toBe('/tickets/.dsh-cli/ticket-two')
    expect(one).not.toBe(two)
    expect(one.startsWith('/tickets/fix-one')).toBe(false)
  })

  it('reuses a shared credential through a symlink without copying or changing it', async () => {
    const shared = join(dir, 'shared')
    await mkdir(shared)
    const target = join(shared, 'token')
    await writeFile(target, 'secret')
    const link = join(dir, 'home', 'token')
    await mkdir(join(dir, 'home'))
    await reuseCredential(target, link)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(target)
    expect(await readFile(target, 'utf8')).toBe('secret')
    // A second call keeps the existing link rather than replacing it.
    await reuseCredential(target, link)
    expect(await readFile(link, 'utf8')).toBe('secret')
  })

  it('skips a credential that does not exist yet', async () => {
    const link = join(dir, 'home', 'missing')
    await mkdir(join(dir, 'home'))
    await reuseCredential(join(dir, 'nowhere'), link)
    await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('prepares a private AGY config with narrow per-Ticket grants and reuses only the OAuth token', async () => {
    const shared = join(dir, 'agy-shared')
    await mkdir(join(shared, 'antigravity-cli'), { recursive: true })
    await mkdir(join(shared, 'config'), { recursive: true })
    await writeFile(join(shared, 'config', 'config.json'), '{"userSettings":{"globalPermissionGrants":{"allow":["command(*)"]}}}')
    await writeFile(join(shared, 'antigravity-cli', 'antigravity-oauth-token'), 'token')
    const home = await prepareAgyHome(join(dir, 'root'), shared, '/opt/node22/bin/node')
    expect(home).toBe(join(dir, 'root', 'home'))
    const configDir = join(home, '.gemini', 'config')
    expect((await lstat(configDir)).isSymbolicLink()).toBe(false)
    const privateConfig = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')) as {
      userSettings: { enableTerminalSandbox: boolean; globalPermissionGrants: { allow: string[]; deny: string[] } }
    }
    expect((await stat(join(configDir, 'config.json'))).mode & 0o777).toBe(0o600)
    expect(privateConfig.userSettings.enableTerminalSandbox).toBe(true)
    expect(privateConfig.userSettings.globalPermissionGrants.allow).toContain('read_file(/opt/node22/bin/node)')
    expect(privateConfig.userSettings.globalPermissionGrants.allow).toContain('command(node --version)')
    expect(privateConfig.userSettings.globalPermissionGrants.allow).toContain('command(git status)')
    expect(privateConfig.userSettings.globalPermissionGrants.allow).toContain('command(./node_modules/.bin/vitest run)')
    expect(privateConfig.userSettings.globalPermissionGrants.allow).not.toContain('command(*)')
    expect(privateConfig.userSettings.globalPermissionGrants.allow).not.toContain('command(node)')
    expect(privateConfig.userSettings.globalPermissionGrants.deny).toContain('command(git push)')
    expect(await readlink(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')))
      .toBe(join(shared, 'antigravity-cli', 'antigravity-oauth-token'))
    expect(await readFile(join(shared, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).toBe('token')
    expect(await readFile(join(shared, 'config', 'config.json'), 'utf8'))
      .toBe('{"userSettings":{"globalPermissionGrants":{"allow":["command(*)"]}}}')
  })

  it('migrates its previous shared-config link to private config without changing the shared target', async () => {
    const shared = join(dir, 'agy-shared')
    await mkdir(join(shared, 'config'), { recursive: true })
    await mkdir(join(shared, 'antigravity-cli'), { recursive: true })
    await writeFile(join(shared, 'config', 'config.json'), '{"from":"shared"}')
    const root = join(dir, 'root')
    const oldConfig = join(root, 'home', '.gemini', 'config')
    await mkdir(join(root, 'home', '.gemini'), { recursive: true })
    await symlink(join(shared, 'config'), oldConfig, 'dir')

    await prepareAgyHome(root, shared, '/opt/node22/bin/node')

    expect((await lstat(oldConfig)).isSymbolicLink()).toBe(false)
    expect(JSON.parse(await readFile(join(oldConfig, 'config.json'), 'utf8')))
      .not.toMatchObject({ from: 'shared' })
    expect(await readFile(join(shared, 'config', 'config.json'), 'utf8')).toBe('{"from":"shared"}')
  })

  it('prepares an isolated CODEX_HOME that reuses the shared auth and config', async () => {
    const shared = join(dir, 'codex-shared')
    await mkdir(shared)
    await writeFile(join(shared, 'auth.json'), '{"a":1}')
    await writeFile(join(shared, 'config.toml'), 'model="x"')
    const home = await prepareCodexHome(join(dir, 'root'), shared)
    expect(home).toBe(join(dir, 'root', 'codex-home'))
    expect(await readlink(join(home, 'auth.json'))).toBe(join(shared, 'auth.json'))
    expect(await readlink(join(home, 'config.toml'))).toBe(join(shared, 'config.toml'))
    expect(await readFile(join(shared, 'auth.json'), 'utf8')).toBe('{"a":1}')
  })

  it('creates a private Grok home without linking shared credentials', async () => {
    const grokHome = await prepareGrokHome(join(dir, 'root'))
    expect(grokHome).toBe(join(dir, 'root', 'grok-user-home', '.grok'))
    expect((await lstat(grokHome)).isSymbolicLink()).toBe(false)
    await expect(lstat(join(grokHome, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates a ticket-private workspace sandbox profile and fails closed on unknown settings', async () => {
    const grokHome = await prepareGrokHome(join(dir, 'root'))
    const profile = join(grokHome, 'sandbox.toml')
    await prepareGrokSandboxProfile(grokHome)
    const config = await readFile(profile, 'utf8')
    expect(config).toContain('extends = "workspace"')
    expect(config).toContain('restrict_network = true')
    expect(config).toContain('"**/.env*"')
    expect((await stat(profile)).mode & 0o777).toBe(0o600)
    await prepareGrokSandboxProfile(grokHome)

    await writeFile(profile, '[profiles.custom]\nextends = "off"\n')
    await expect(prepareGrokSandboxProfile(grokHome)).rejects.toThrow('unexpected settings')
  })
})
