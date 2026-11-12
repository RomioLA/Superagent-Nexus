/** Read-only Codex App Server account/rateLimits/read integration. */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexCliPath, prepareCodexHome } from './tools/cli-isolation.ts'

export type CodexQuotaStatus = 'available' | 'rate-limited' | 'unknown'
export type CodexQuotaError = 'cancelled' | 'timeout' | 'spawn-failed' | 'protocol-error' | 'read-failed' | 'invalid-response'

export interface CodexQuotaWindow {
  availability: 'available' | 'exhausted' | 'unknown'
  window_duration_mins?: number
  used_percent?: number
  remaining_percent?: number
  resets_at?: string
}

export interface CodexRateLimit {
  limit_id?: string
  primary?: CodexQuotaWindow
  secondary?: CodexQuotaWindow
  rate_limit_reached_type?: string
}

export interface CodexQuotaSnapshot {
  status: CodexQuotaStatus
  checked_at: string
  limit_id?: string
  primary?: CodexQuotaWindow
  secondary?: CodexQuotaWindow
  rate_limit_reached_type?: string
  ordinary_usage_allowed?: boolean
  rate_limits_by_limit_id?: Record<string, CodexRateLimit>
  error?: CodexQuotaError
}

export interface CodexQuotaReaderOptions {
  /** Override the installed CLI in tests; runtime uses the same binary as the DSH Codex Executor. */
  executable?: string
  timeoutMs?: number
  now?: () => Date
}

type Json = Record<string, unknown>
type AppServerReply = { result?: unknown; error?: CodexQuotaError }
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined

function resetTime(value: unknown): string | undefined {
  const milliseconds = typeof value === 'number' && Number.isFinite(value) ? value * 1000
    : typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(milliseconds)) return
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function quotaWindow(value: unknown): CodexQuotaWindow | undefined {
  if (!isRecord(value)) return
  const duration = finite(value.windowDurationMins)
  const used = finite(value.usedPercent)
  const resetsAt = resetTime(value.resetsAt)
  return {
    availability: used === undefined ? 'unknown' : used >= 100 ? 'exhausted' : 'available',
    ...(duration !== undefined ? { window_duration_mins: duration } : {}),
    ...(used !== undefined ? { used_percent: used, remaining_percent: 100 - used } : {}),
    ...(resetsAt ? { resets_at: resetsAt } : {}),
  }
}

function rateLimit(value: unknown): CodexRateLimit | undefined {
  if (!isRecord(value)) return
  const primary = quotaWindow(value.primary)
  const secondary = quotaWindow(value.secondary)
  const reached = text(value.rateLimitReachedType)
  return {
    ...(text(value.limitId) ? { limit_id: text(value.limitId) } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(reached ? { rate_limit_reached_type: reached } : {}),
  }
}

/** Normalize only fields reported by account/rateLimits/read; account identifiers and other response data are omitted. */
export function parseCodexQuotaResponse(value: unknown, checkedAt: string): CodexQuotaSnapshot {
  if (!isRecord(value)) return { status: 'unknown', checked_at: checkedAt, error: 'invalid-response' }
  const limits = rateLimit(value.rateLimits)
  const reached = limits?.rate_limit_reached_type ?? text(value.rateLimitReachedType)
  const ordinaryUsageAllowed = typeof value.ordinaryUsageAllowed === 'boolean' ? value.ordinaryUsageAllowed : undefined
  const windows = [limits?.primary, limits?.secondary].filter((item): item is CodexQuotaWindow => !!item)
  const status: CodexQuotaStatus = reached || ordinaryUsageAllowed === false
    ? 'rate-limited'
    : ordinaryUsageAllowed === true ? 'available'
      : windows.some(item => item.availability === 'exhausted') ? 'rate-limited'
        : windows.length === 2 && windows.every(item => item.availability === 'available')
      ? 'available' : 'unknown'
  const byLimit = isRecord(value.rateLimitsByLimitId)
    ? Object.fromEntries(Object.entries(value.rateLimitsByLimitId).flatMap(([id, item]) => {
      const parsed = rateLimit(item)
      return parsed ? [[id, parsed]] : []
    })) as Record<string, CodexRateLimit>
    : undefined
  return {
    status, checked_at: checkedAt,
    ...(limits?.limit_id ? { limit_id: limits.limit_id } : {}),
    ...(limits?.primary ? { primary: limits.primary } : {}),
    ...(limits?.secondary ? { secondary: limits.secondary } : {}),
    ...(reached ? { rate_limit_reached_type: reached } : {}),
    ...(ordinaryUsageAllowed !== undefined ? { ordinary_usage_allowed: ordinaryUsageAllowed } : {}),
    ...(byLimit ? { rate_limits_by_limit_id: byLimit } : {}),
  }
}

function requestRateLimits(executable: string, home: string, codexHome: string, timeoutMs: number,
  signal?: AbortSignal): Promise<AppServerReply> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        ['PATH', 'USER', 'SHELL', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(key)))
      child = spawn(executable, ['app-server'], {
        cwd: home,
        env: { ...inherited, HOME: home, CODEX_HOME: codexHome, TMPDIR: home,
          XDG_CACHE_HOME: join(home, 'cache'), GIT_TERMINAL_PROMPT: '0' },
        stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32',
      })
    } catch { resolve({ error: 'spawn-failed' }); return }

    const stdin = child.stdin!
    const stdout = child.stdout!
    let buffer = '', failure: CodexQuotaError | undefined, response: unknown, gotResponse = false
    let serverError = false, settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const newline = '\n'
    const cleanup = () => {
      clearTimeout(deadline)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (reply: AppServerReply) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(reply)
    }
    const kill = (name: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, name)
        else child.kill(name)
      } catch { try { child.kill(name) } catch { /* already exited */ } }
    }
    const stop = (reason: CodexQuotaError) => {
      if (failure || settled) return
      failure = reason
      stdin.end()
      kill('SIGTERM')
      killTimer = setTimeout(() => kill('SIGKILL'), 3000)
      killTimer.unref?.()
    }
    const onAbort = () => stop('cancelled')
    const deadline = setTimeout(() => stop('timeout'), timeoutMs)
    deadline.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    const send = (message: Json) => stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + newline)
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 1_000_000 && !buffer.includes(newline)) { stop('protocol-error'); return }
      let end: number
      while ((end = buffer.indexOf(newline)) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + newline.length)
        if (!line.trim()) continue
        let message: unknown
        try { message = JSON.parse(line) } catch { stop('protocol-error'); return }
        if (!isRecord(message)) continue
        if (message.id === 1) {
          if (message.error || !isRecord(message.result)) { failure = 'protocol-error'; stdin.end(); continue }
          try {
            send({ method: 'initialized' })
            send({ id: 2, method: 'account/rateLimits/read', params: {} })
          } catch { stop('protocol-error') }
        } else if (message.id === 2) {
          gotResponse = true
          if (message.error) serverError = true
          else response = message.result
          stdin.end()
        }
      }
    })
    stdin.on('error', () => { if (!gotResponse) stop('protocol-error') })
    child.once('error', () => finish({ error: 'spawn-failed' }))
    child.once('close', code => finish(failure ? { error: failure }
      : serverError || code !== 0 ? { error: 'read-failed' }
        : gotResponse ? { result: response } : { error: 'protocol-error' }))
    try {
      send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'dsh-superagent', version: '0.1.0' }, capabilities: { experimentalApi: true },
      } })
    } catch { stop('protocol-error') }
  })
}

/** Uses the existing shared Codex login through a temporary CODEX_HOME; App Server runtime state is removed after each read. */
export function createCodexQuotaReader(options: CodexQuotaReaderOptions = {}): (signal?: AbortSignal) => Promise<CodexQuotaSnapshot> {
  const now = options.now ?? (() => new Date())
  const timeoutMs = options.timeoutMs ?? 20_000
  return async signal => {
    let root: string | undefined
    try {
      if (signal?.aborted) return { status: 'unknown', checked_at: now().toISOString(), error: 'cancelled' }
      root = await mkdtemp(join(tmpdir(), 'dsh-codex-quota-'))
      const codexHome = await prepareCodexHome(root)
      const reply = await requestRateLimits(options.executable ?? codexCliPath(), root, codexHome, timeoutMs, signal)
      const checkedAt = now().toISOString()
      return reply.error
        ? { status: 'unknown', checked_at: checkedAt, error: reply.error }
        : parseCodexQuotaResponse(reply.result, checkedAt)
    } catch {
      return { status: 'unknown', checked_at: now().toISOString(), error: 'read-failed' }
    } finally {
      if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  }
}
