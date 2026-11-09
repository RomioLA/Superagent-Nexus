/** Pure task-intent helpers and read-only access to historical V0.3 results.
 * All NEW tasks are native DSH Tickets, not a second task ledger.
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Ticket } from '../core/index.ts'
import { latestReport, ticketStage } from '../core/index.ts'

export type TaskKind = 'read' | 'write'
const slash = /^\/(?:task|run|exec)(?:\s+|$)/i

export function normalizedTask(text: string): string {
  return text.trim().replace(slash, '').replace(/^(?:只读|readonly)\s+/i, '').trim()
}
export function taskKind(text: string): TaskKind | undefined {
  const explicit = slash.test(text.trim())
  const requestedReadOnly = /^\/(?:task|run|exec)\s+(?:只读|readonly)\s+/i.test(text)
  const detail = normalizedTask(text)
  if (!detail || detail.length > 2000) return
  if (/^(?:请问|是否|要不要|需不需要|有没有|为什么|怎么|如何|能不能|能否|应该|会不会|可不可以|你觉得|讨论|假设|如果|what\b|why\b|how\b)/i.test(detail)) return
  if (/(?:自动合并|强制推送|删除仓库|删除分支|直接发布|推送main|推送主分支|合并到main)/i.test(detail)) return
  const write = /^(?:(?:请你|请帮我|请|帮我|麻烦|你来|直接|现在|把|将)\s*)?(?:把|将|在.{1,80}?)(?:.{0,80}?)(?:改成|改为|替换为|写入|新增|增加|添加|修复|实现|删除)/i.test(detail)
    || /^(?:(?:请你|请帮我|请|帮我|麻烦|你来|直接|现在)\s*)?(?:修改|修复|实现|开发|新增|增加|添加|更新|重构|优化|调整|改写|编写|创建|完成|fix\b|edit\b|update\b|implement\b|add\b|refactor\b)/i.test(detail)
  if (write) return requestedReadOnly ? 'read' : 'write'
  if (/^(?:(?:请|帮我|请帮我|你来)\s*)?(?:检查|查看|阅读|审查|分析|核对|读取|搜索|查询|诊断|调查|测试|检索|总结|看看|看一下|找出|比较|告诉我|review\b|check\b|inspect\b|analy[sz]e\b)/i.test(detail)) return 'read'
  return explicit ? 'read' : undefined
}

export function cheapReadmeQuery(detail: string): boolean {
  return /\breadme(?:\.md)?\b/i.test(detail)
    && /(?:标题|简介|介绍|项目名|title|description|summary)/i.test(detail)
    && !/(?:比较|对比|所有|全仓|设计|分析|风险|依赖|测试|历史|版本|结构|搜索|差异|改进|原因|是否需要修改|审查代码|其他文件)/i.test(detail)
}
export function summarizeReadme(content: string): string {
  const lines = content.replace(/\r/g, '').split('\n')
  const i = lines.findIndex(line => /^#\s+\S/.test(line))
  const title = i < 0 ? '未找到一级标题' : lines[i]!.replace(/^#\s+/, '').trim()
  const intro = lines.slice(Math.max(0, i + 1)).map(line => line.trim())
    .find(line => line && !line.startsWith('#') && !line.startsWith('<!--'))
  return 'README.md（本地读取；无 Codex 调用）\n标题：' + title + '\n简介：' + (intro?.slice(0, 500) ?? '未找到简介')
}
export async function readReadmeFromProject(directory: string): Promise<string> {
  if (await realpath(directory) !== directory) throw new Error('Project path must be canonical')
  const file = join(directory, 'README.md')
  if (await realpath(file) !== file || (await stat(file)).size > 32768) throw new Error('README not a local regular file within size limit')
  return summarizeReadme(await readFile(file, 'utf8'))
}

/** Legacy V0.3 reports remain readable but no longer control execution. */
export async function legacyResult(id: string, actorId: string, chatId: string): Promise<string | undefined> {
  if (!/^[0-9a-f]{16}$/.test(id)) return
  const path = join(homedir(), '.config/superagent/task-router-state.json')
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as { tasks?: { id: string; actorId: string; chatId: string;
      status: string; summary?: string; prUrl?: string; usageTokens?: number }[] }
    const entry = data.tasks?.find(task => task.id === id && task.actorId === actorId && task.chatId === chatId)
    if (!entry) return
    return '历史任务 [' + id + '] ' + entry.status
      + (entry.prUrl ? '\nPR：' + entry.prUrl : '')
      + (entry.usageTokens ? '\nCodex Tokens：' + entry.usageTokens : '')
      + '\n' + (entry.summary ?? '无结果')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
export function nativeTicketStatus(ticket: Ticket): string {
  const stage = ticket.ended ? 'ended/' + ticket.ended.outcome : ticketStage(ticket).stage
  const refs = ticket.follows?.filter(f => f.thread.startsWith('github:')).map(f => f.thread).slice(0, 3) ?? []
  const report = latestReport(ticket)
  return ticket.id + ' | ' + stage + ' | ' + ticket.title.slice(0, 70)
    + (refs.length ? '\nPR 关联：' + refs.join(', ') : '')
    + (report ? '\n' + report.state + '：' + report.summary.slice(0, 1500) : '')
}
