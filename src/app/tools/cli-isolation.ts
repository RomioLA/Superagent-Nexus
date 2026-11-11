/**
 * Per-Ticket isolation for the executor CLIs: temporary files, caches and per-run artifacts live under a
 * Ticket-specific directory beside its workspace, so parallel Tickets never share them. Existing Codex and
 * Antigravity credentials are reused through symlinks; Grok gets a private home and never borrows shared auth.
 */
import { chmod, lstat, mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'

/** Root of one Ticket's CLI temporary files, caches and artifacts; a sibling of the workspace, never inside the checkout. */
export function cliStateDir(ticketDirectory: string, ticketId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ticketId)) throw new Error('Invalid Ticket ID for CLI state path')
  return join(dirname(ticketDirectory), '.dsh-cli', ticketId)
}

/** Creates `path` (and any parent) private to the owner and returns it. */
export async function ensureCliDir(path: string): Promise<string> {
  const absolute = resolve(path)
  const { root } = parse(absolute)
  let current = root
  for (const part of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('CLI state path contains a non-directory or symlink')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await mkdir(current, { mode: 0o700 }) } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      }
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('CLI state path contains a non-directory or symlink')
    }
  }
  if (await realpath(absolute) !== absolute) throw new Error('CLI state path resolves outside its declared location')
  await chmod(absolute, 0o700)
  return absolute
}

/** Points `link` at an existing `target` once, so the CLI reuses the deployment's credential without a copy or a write to it. */
export async function reuseCredential(target: string, link: string): Promise<void> {
  try {
    const existing = await lstat(link)
    if (!existing.isSymbolicLink() || await realpath(link) !== await realpath(target)) {
      throw new Error('CLI credential link points to an unexpected target')
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try { await lstat(target) } catch { return /* No existing credential to reuse. */ }
  try { await symlink(target, link) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await realpath(link) !== await realpath(target)) throw new Error('CLI credential link points to an unexpected target')
  }
}

/** The shared Antigravity home the deployment already authenticated. */
export const sharedAgyHome = (): string => join(homedir(), '.gemini')
/** The shared Codex home the deployment already authenticated. */
export const sharedCodexHome = (): string => join(homedir(), '.config/superagent/codex-home')

/** Creates a private Grok home for one Ticket. No shared Grok credential is copied or linked into it. */
export async function prepareGrokHome(root: string): Promise<string> {
  const home = await ensureCliDir(join(root, 'grok-user-home'))
  return ensureCliDir(join(home, '.grok'))
}

const grokSandboxProfile = [
  '[profiles.dsh-ticket]',
  'extends = "workspace"',
  'restrict_network = true',
  'deny = [',
  '  "**/.env*",',
  '  "**/.npmrc",',
  '  "**/.pypirc",',
  '  "**/.netrc",',
  '  "**/auth.json",',
  '  "**/mcp_credentials.json",',
  '  "**/.git",',
  '  "**/.git/**",',
  '  "**/*.pem",',
  '  "**/*.key",',
  '  "**/*.p12",',
  '  "**/*.pfx",',
  '  "**/.aws/**",',
  '  "**/.ssh/**",',
  ']',
  '',
].join('\n')

/** Configures Grok's official workspace sandbox for this Ticket's isolated home, preserving unknown settings. */
export async function prepareGrokSandboxProfile(grokHome: string): Promise<void> {
  const path = join(grokHome, 'sandbox.toml')
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Grok sandbox config is not a regular file')
    const existing = await readFile(path, 'utf8')
    if (existing !== '' && existing !== grokSandboxProfile)
      throw new Error('Grok sandbox config already contains unexpected settings')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await writeFile(path, grokSandboxProfile, { mode: 0o600 })
  await chmod(path, 0o600)
}

/** Narrow AGY grants for native development commands; no general shell or interpreter grant. */
export function agyPermissionGrants(
  nodeExecutable: string = process.execPath,
  dependencyDirectory?: string,
): { allow: string[]; deny: string[] } {
  if (!nodeExecutable.startsWith('/') || /[\r\n)]/.test(nodeExecutable)) throw new Error('Invalid Node executable path')
  if (dependencyDirectory && (!dependencyDirectory.startsWith('/') || /[\r\n)]/.test(dependencyDirectory)))
    throw new Error('Invalid project dependency path')
  const allow = [
    `read_file(${nodeExecutable})`,
    ...(dependencyDirectory ? [`read_file(${dependencyDirectory})`] : []),
    'command(node --version)',
    'command(git --version)',
    'command(git status)',
    'command(git diff)',
    'command(git log)',
    'command(git show)',
    'command(git ls-files)',
    'command(./node_modules/.bin/vitest run)',
    'command(pnpm test)',
    'command(pnpm run test)',
    'command(npm test)',
    'command(npm run test)',
    'command(yarn test)',
    'command(yarn run test)',
    'command(bun test)',
  ]
  return {
    allow,
    deny: [
      'command(git push)',
      'command(git commit)',
      'command(git merge)',
      'command(git reset)',
      'command(git clean)',
      'command(git checkout)',
      'command(git switch)',
      'command(gh)',
      'command(sudo)',
    ],
  }
}

/** Replace only this Ticket's old link to the shared config directory; never alter its shared target. */
async function ensurePrivateAgyConfigDir(configDir: string, sharedConfigDir: string): Promise<void> {
  try {
    const info = await lstat(configDir)
    if (info.isSymbolicLink()) {
      if (await realpath(configDir) !== await realpath(sharedConfigDir))
        throw new Error('AGY config link points to an unexpected target')
      await unlink(configDir)
    } else if (!info.isDirectory() || await realpath(configDir) !== configDir) {
      throw new Error('AGY config path is not a private directory')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try { await mkdir(configDir, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const info = await lstat(configDir)
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(configDir) !== configDir)
    throw new Error('AGY config path is not a private directory')
  await chmod(configDir, 0o700)
}

async function writeAgyConfig(path: string, grants: { allow: string[]; deny: string[] }): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('AGY config file is not a regular file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const config = {
    userSettings: {
      enableTerminalSandbox: true,
      globalPermissionGrants: grants,
    },
  }
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await chmod(path, 0o600)
}

/**
 * Creates a Ticket-isolated Antigravity home. The OAuth token is reused by symlink; permissions and settings are
 * written privately for this Ticket and never added to the operator's shared configuration.
 */
export async function prepareAgyHome(
  root: string,
  shared: string = sharedAgyHome(),
  nodeExecutable: string = process.execPath,
  dependencyDirectory?: string,
): Promise<string> {
  const home = await ensureCliDir(join(root, 'home'))
  const gemini = join(home, '.gemini')
  const cli = await ensureCliDir(join(gemini, 'antigravity-cli'))
  const config = join(gemini, 'config')
  await ensurePrivateAgyConfigDir(config, join(shared, 'config'))
  await writeAgyConfig(join(config, 'config.json'), agyPermissionGrants(nodeExecutable, dependencyDirectory))
  await reuseCredential(join(shared, 'antigravity-cli', 'antigravity-oauth-token'), join(cli, 'antigravity-oauth-token'))
  return home
}

/** Creates a Ticket-isolated CODEX_HOME, reusing the shared auth.json and config.toml so Codex stays signed in. */
export async function prepareCodexHome(root: string, shared: string = sharedCodexHome()): Promise<string> {
  const home = await ensureCliDir(join(root, 'codex-home'))
  await reuseCredential(join(shared, 'auth.json'), join(home, 'auth.json'))
  await reuseCredential(join(shared, 'config.toml'), join(home, 'config.toml'))
  return home
}
