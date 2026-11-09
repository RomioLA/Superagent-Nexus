/** Single-user Feishu P2P chat and native DSH task ingress.
 * One Source consumer. No parallel task ledger, global worker lock, or independent Codex PR dispatcher.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Trigger } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import { taskKind, normalizedTask, cheapReadmeQuery, readReadmeFromProject, legacyResult, nativeTicketStatus } from './feishu-task-router.ts'

export type Project = { id: string; name: string; aliases: string[]; status: 'test' | 'disabled'; repository?: string; directory?: string }
type Config = { enabled: boolean; allowedUser: string; projects: Project[] }
type State = { selected: Record<string, string>; handled: string[]; staleWarnings?: Record<string, number> }
export type ChatIntent = 'help' | 'projects' | 'select' | 'task' | 'chat'
const root = join(homedir(), '.config', 'superagent')
const configPath = join(root, 'chat-router.json')
const statePath = join(root, 'chat-router-state.json')
const inFlight = new Set<string>()
const defaultState = (): State => ({ selected: {}, handled: [] })
const maxAgeMs = 24 * 60 * 60_000

export function arrivalWindow(at: string, task: boolean, now = Date.now()): 'fresh' | 'delayed-task' | 'archived' {
  const elapsed = now - Date.parse(at)
  if (!Number.isFinite(elapsed) || elapsed < -5 * 60_000 || elapsed > maxAgeMs) return 'archived'
  return 'fresh'
}
export function plainText(content: string): string {
  try {
    const value: unknown = JSON.parse(content)
    if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text
  } catch { /* Some Feishu events already carry plain text. */ }
  return content
}
export function intentOf(text: string): ChatIntent {
  const phrase = text.trim()
  if (/^(?:\/help|帮助|菜单|\/start)$/i.test(phrase)) return 'help'
  if (/^(?:\/projects|项目列表|有哪些项目)$/i.test(phrase)) return 'projects'
  if (/^(?:\/project|切换项目|选择项目)(?:\s+|[：:])?/i.test(phrase)) return 'select'
  return taskKind(phrase) ? 'task' : 'chat'
}
export function projectOf(text: string, projects: Project[]): Project | undefined {
  const lower = text.toLowerCase()
  return projects.find(project => [project.id, project.name, ...project.aliases].some(alias => alias && lower.includes(alias.toLowerCase())))
}
export function projectList(projects: Project[]): string {
  if (!projects.length) return '目前没有登记的项目。'
  return projects.map(p => '· ' + p.name + ' — ' + (p.status === 'test' ? '可执行' : '暂未接入')).join('\n')
}
async function config(): Promise<Config | undefined> {
  try {
    const value = JSON.parse(await readFile(configPath, 'utf8')) as Config
    if (!/^ou_[a-zA-Z0-9]+$/.test(value.allowedUser) || !Array.isArray(value.projects)) throw new Error('Invalid chat config')
    return value.enabled ? value : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
async function state(): Promise<State> {
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8')) as State
    if (value && value.selected && Array.isArray(value.handled)) return value
    throw new Error('Invalid Feishu conversation state')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultState()
    throw error
  }
}
async function save(value: State): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
  const tmp = statePath + '.' + process.pid + '.tmp'
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, statePath)
}
function belongs(ctx: SourceContext, id: string, actorId: string, chatId: string): boolean {
  const ticket = ctx.tickets.get(id)
  const origin = ticket && ctx.triggers.get(ticket.origin.triggerId)
  return !!ticket && origin?.actor.id === actorId && origin.meta.chatId === chatId
}
export function nativeTaskRequest(trigger: Trigger, text: string, kind: 'read' | 'write', repository: string) {
  const detail = normalizedTask(text)
  const localOnly = /(?:只在本地|仅本地|不要(?:创建|生成|提交|发起) ?PR|不(?:创建|生成|提交|发起) ?PR|不推送|无需PR|no ?PR\b|without (?:a )?pull request)/i.test(detail)
  const note = kind === 'write'
    ? (localOnly
      ? 'Use the native DSH Ticket worktree. For complex edits consider orchestrator_codex mode=write; use native DSH tools for simple text changes to avoid double model calls. Run available tests, then report ready with the local worktree path. Do not commit, push, merge, deploy or create a PR. Only report tests actually run.'
      : 'Use the native DSH Ticket worktree. For complex edits use orchestrator_codex mode=write; for simple edits use native DSH tools directly to avoid duplicate model calls. Inspect diff, run available project tests, commit and create a reviewable GitHub PR on the Ticket branch. Do not merge or deploy; only report tests actually run.')
    : 'Read-only task in native DSH Ticket. Use orchestrator_codex mode=read-only as appropriate. Do not edit, commit, publish or create a PR. Report findings to the requester.'
  return {
    title: detail.slice(0, 90),
    scope: 'Owner-authorized ' + kind + ' task in configured repository ' + repository + ' only: ' + detail.slice(0, 350),
    name: 'feishu-' + trigger.id.slice(0, 10),
    note,
    acknowledgement: kind === 'write'
      ? (localOnly ? '已建立 DSH 本地开发工单，将修改工作区并检查；不提交或创建 PR。'
        : '已建立 DSH 开发工单，将在任务工作区执行并创建可审查的 PR；不会自动合并。')
      : '已建立 DSH 只读工单，结果完成后回复。',
  }
}
async function answerChat(ctx: SourceContext, trigger: Trigger, selected?: Project): Promise<string> {
  const raw = await ctx.commands.lark<{ messages?: { message_id?: string; msg_type?: string; deleted?: boolean;
    content?: string; sender?: { sender_type?: string }; create_time?: string }[] }>(
    ['im', '+chat-messages-list', '--chat-id', String(trigger.meta.chatId), '--no-reactions', '--page-size', '12'])
    .catch(() => ({ messages: [] }))
  const previous = (raw.messages ?? []).filter(row => !row.deleted && row.msg_type === 'text' && row.content)
    .sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0)).slice(-10)
    .map(row => ({ role: row.sender?.sender_type === 'user' ? 'user' : 'assistant', content: plainText(row.content!).slice(0, 1000) }))
  if (!(raw.messages ?? []).some(row => row.message_id === String(trigger.meta.messageId))) previous.push({
    role: 'user', content: plainText(trigger.text).slice(0, 1000),
  })
  const base = process.env.MAGPIE_GATEWAY_BASE_URL
  const secret = process.env.MAGPIE_ROUTER_KEY
  if (!base?.startsWith('http://') || !secret) throw new Error('Router model not configured')
  const response = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto/deepseek-v4.1-flash', stream: false, max_tokens: 420,
      messages: [{ role: 'system', content: '你是 Super-agent 的中文聊天助手。你可以解释问题，但聊天本身不能操作文件、声称执行或提交 PR。清晰的开发/检查指令由独立的原生 DSH Ticket 入口自动接收，不需要斜杠命令。当前项目：' + (selected?.name ?? '测试仓库') + '。回答简洁、准确。' }, ...previous] }),
  })
  if (!response.ok) throw new Error('Chat model HTTP ' + response.status)
  const value = await response.json() as { choices?: { message?: { content?: string | null } }[] }
  return value.choices?.[0]?.message?.content?.trim()?.slice(0, 1500) || '对话模型未返回内容。'
}
export async function handleFeishuChat(ctx: SourceContext, trigger: Trigger): Promise<boolean> {
  const cfg = await config()
  if (!cfg || !trigger.human || trigger.meta.direct !== true) return false
  // Replies in a native Ticket thread are native DSH inputs, not fresh chat or task requests.
  if (typeof trigger.meta.rootId === 'string' && trigger.meta.rootId !== trigger.meta.messageId) return false
  if (typeof trigger.meta.parentId === 'string' && trigger.meta.parentId !== trigger.meta.messageId) return false
  // Native DSH policy also admits only this sender; other P2P requests never reach the coding Executor.
  if (trigger.actor.id !== cfg.allowedUser) return false
  const messageId = String(trigger.meta.messageId ?? '')
  const chatId = String(trigger.meta.chatId ?? '')
  if (!/^om_[a-zA-Z0-9_]+$/.test(messageId) || !/^oc_[a-zA-Z0-9]+$/.test(chatId)) return true
  const text = plainText(trigger.text).trim().slice(0, 4000)
  if (!text || inFlight.has(messageId)) return true
  inFlight.add(messageId)
  try {
    const data = await state()
    if (data.handled.includes(messageId)) return true
    const kind = taskKind(text)
    const age = arrivalWindow(trigger.at, !!kind)
    if (age === 'archived') {
      // Historic unhandled messages must not unexpectedly start work during backfill.
      data.handled = [...data.handled, messageId].slice(-4000)
      await save(data)
      return true
    }
    const project = cfg.projects.find(p => p.id === data.selected[chatId])
      ?? cfg.projects.find(p => p.status === 'test')
    const mentioned = projectOf(text, cfg.projects)
    let response: string | undefined
    const select = intentOf(text)
    if (select === 'help') response = '可直接说「修改 README 简介」或「检查 README 标题」，无需 /task。/projects 查看项目，/project 选择，/tasks 查 DSH 工单，/result 编号 查看结果，/cancel 编号 停止任务；开发任务默认创建 PR，不自动合并。'
    else if (select === 'projects') response = projectList(cfg.projects)
    else if (select === 'select') {
      const name = text.replace(/^(?:\/project|切换项目|选择项目)(?:\s+|[：:])?/i, '').trim()
      const chosen = projectOf(name, cfg.projects)
      if (!chosen) response = '请选择项目：\n' + projectList(cfg.projects)
      else if (chosen.status === 'disabled') response = chosen.name + '尚未接入，不会执行任务。'
      else { data.selected[chatId] = chosen.id; response = '已选择 ' + chosen.name + '。可直接使用自然语言派工，不需要 /task。' }
    } else if (/^\/tasks\s*$/i.test(text)) {
      const list = ctx.tickets.list().filter(ticket => belongs(ctx, ticket.id, trigger.actor.id, chatId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6)
      response = list.length ? list.map(nativeTicketStatus).join('\n\n') : '暂无原生 DSH 工单（历史 V0.3 可通过 /result 旧编号查询）。'
    } else if (/^\/result\s+([0-9a-f]{16}|[0-9a-f]{32})\s*$/i.test(text)) {
      const id = text.split(/\s+/)[1]!
      response = belongs(ctx, id, trigger.actor.id, chatId)
        ? nativeTicketStatus(ctx.tickets.get(id)!) : await legacyResult(id, trigger.actor.id, chatId) ?? '任务不存在或不属于当前会话。'
    } else if (/^\/cancel\s+[0-9a-f]{32}\s*$/i.test(text)) {
      const id = text.split(/\s+/)[1]!
      if (!belongs(ctx, id, trigger.actor.id, chatId)) response = '任务不存在或不属于当前会话。'
      else { ctx.stopTask(id, 'Stopped by owner in Feishu'); response = '已向原生 DSH 停止工单 ' + id + '。' }
    } else if (/^\/retry\s+[0-9a-f]{32}\s*$/i.test(text)) {
      const id = text.split(/\s+/)[1]!
      if (!belongs(ctx, id, trigger.actor.id, chatId)) response = '任务不存在或不属于当前会话。'
      else { ctx.retryTask(id); response = '已按原生 DSH 机制重试工单 ' + id + '，沿用原工作区。' }
    } else if (/^\/confirm\s+[0-9a-f]{16}$/i.test(text)) {
      response = '不再需要二次确认。直接用自然语言描述要执行的任务即可。'
    } else if (mentioned?.status === 'disabled' && kind) {
      response = mentioned.name + '尚未接入。当前仅测试仓库支持自动派工。'
    } else if (kind) {
      if (!project || project.status !== 'test' || project.repository !== ctx.deployment.repository) response = '当前选定项目没有与原生 DSH 配置的仓库匹配，未执行。'
      else if (kind === 'read' && project.directory && cheapReadmeQuery(normalizedTask(text))) response = await readReadmeFromProject(project.directory)
      else {
        const result = ctx.acceptTask(trigger, nativeTaskRequest(trigger, text, kind, project.repository))
        if (result.received === 'stored') {
          // Native Engine persists the Ticket and queues the acknowledgement/recovery; this chat Router creates neither.
          data.handled = [...data.handled, messageId].slice(-4000)
          await save(data)
          return true
        }
        response = '原生 DSH 已处理这条消息（' + result.received + '），不会重复派工。'
      }
    } else {
      try { response = await answerChat(ctx, trigger, mentioned ?? project) }
      catch { response = '聊天模型暂时不可用。没有启动任何执行任务。' }
    }
    const key = createHash('sha256').update('superagent-chat:' + messageId).digest('hex').slice(0, 40)
    await ctx.commands.lark(['im', '+messages-reply', '--message-id', messageId, '--text', response || '已处理。',
      '--idempotency-key', key])
    data.handled = [...data.handled, messageId].slice(-4000)
    await save(data)
    return true
  } finally { inFlight.delete(messageId) }
}
