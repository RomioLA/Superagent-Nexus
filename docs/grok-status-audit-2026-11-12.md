# Grok stop-loss and explicit Ticket status answers

Date: 2026-11-12 (Asia/Hong_Kong). Starting checkout: clean
`codex/magpie-cost-routing`, `0734f67af68e588edef76a727c0dd2297a05d04a`.
Only this development checkout was changed; no production checkout/database access,
deployment, restart, push, merge, or real Grok model run was performed.

## Native capability decision

Official DSH upstream was checked through GitHub; its current main is
[`8c32a9d`](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4).
Its objects are already available locally, so `git show 8c32a9d:<path>` was used
for comparison. In particular, upstream `src/app/notices.ts`,
`src/core/replies.ts`, `src/core/assignments.ts`, `src/core/tickets.ts`,
`src/app/outbox.ts`, `src/executor/dsh.ts`, and the work/reply/dispatch prompts
already provide Ticket execution, steering, reports, answer authorization,
receipts, cancellation, retries and durable delivery. There is no upstream Grok
adapter to enable instead of the customized adapter. DSH's per-request output
`maxTokens` and provider budget retry observation do not cap an external CLI's
spend; those settings and all AGY/Codex adapters remain unchanged.

The installed official CLI reports `grok 1.0.80 (b200360b6562)`.
Only help/version were inspected, without starting model work. Its main,
`agent`, and `agent headless` help expose `--max-turns`, but no dollar/token
budget or stall limit. The official [headless documentation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)
and [tool-loop implementation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs)
confirm that this is an agent/tool-loop boundary, not a model-call, token or
dollar cap. Documentation/source main may evolve independently of installed
1.0.80. NDJSON `usage` events expose response usage; terminal `end` exposes
aggregate usage/modelUsage/cost. No reliable real-time dollar limit was found.
The existing isolated process-group SIGTERM/SIGKILL cancellation, 150-second
read timeout and 480-second write timeout remain intact.

For status inquiries, upstream already fans follow-ups out to Workers and
relays them to the main Session. However, the notice/dispatch instructions allow
the main Session only to stop work. Native `answer` requires a Worker report
with `reply_to_trigger_id`, which becomes `ticket.answers`. Routine progress
is intentionally not relayed. `requestStatus` only queues a report request when
the latest Worker report is `waiting`; it cannot answer for a busy Worker.
A prompt-only change cannot pass the native `noAnswer` gate. This explains the
structural gap without introducing another notification mechanism.

## Minimal changes

- Reuse official `--max-turns`: default 12; values 1–50 remain possible, with
  `limit_reason` required above 12 for initial task complexity. Recognize the
  native exhaustion event/stop reason as failure, not completion.
- Refuse another Grok run after failure in the same Assignment. An explicit
  native Ticket retry creates a new Assignment and can use the same persistent
  Worker/tool binding. This guard is in memory and is not a durable budget.
- For write-mode success, require a completed edit tool and newly observed file
  metadata changes. Inventory comes from Git's tracked/untracked, non-ignored
  files; only `lstat` metadata is inspected, not file contents or credentials.
  Existing dirty files alone do not count. Missing evidence fails closed.
  A later Grok attempt revokes older `harnessRun` ready authorization, so failure
  cannot borrow a prior success from that Assignment. Persist the run mode and
  write evidence in that same native record. A Grok write Ticket cannot report
  `ready` with only a read-only run or missing evidence. Explicit inspection-only
  tasks select `harness={"harness":"grok","readOnly":true}` at acceptance; writes
  are refused for those tasks, including through an explicitly allowed fallback.
  An allowed fallback must also run read-only to report inspection completion.
  A successful read-only review can retain earlier
  verified writes in the same Assignment; failure still clears ready evidence.
- Extend existing `orchestrator_reply` with `purpose=answer, status_only=true`.
  The host ignores model-written text and generates a source-language snapshot
  from native `ticketStage`. A running state explicitly does not confirm
  healthy execution or task success. Human, source-channel and non-context
  Ticket reach checks remain mandatory. Technical answer authorization is
  unchanged and is neither granted nor consumed by a status answer.
- Reuse Outbox with `key('status', ticket.id, trigger.id)` for stable delivery
  and retries. Update the existing notice and prompts to allow this precise
  response while keeping ordinary progress internal. Retain the original
  Prompt character budgets. Architecture inventory entries include the new
  tests and two pre-existing Magpie omissions discovered by the docs check.

No scheduler, keyword router, notifier, queue, billing engine or alternate
Ticket/state manager was added.

## Verification

The targeted Vitest checks covered 19 files (regression run plus final focused rerun): Grok arguments and simulated CLI
processes, status replies, follow-ups, P0 notification integration, native
routing, AGY/Codex, CLI isolation/security, Outbox, core engine, runtime,
Prompt surfaces, documentation, delivery, retry health and queue.
Result: **374 passed, 2 skipped** (the existing opt-in AGY live smoke tests).
`pnpm typecheck`, `pnpm build`, and `git diff --check` passed.

New cases cover native limit exhaustion at both zero/nonzero exit, suppression
of repeat calls/limit escalation after failure, claimed writes with no edits,
completed tools without workspace changes, workspace changes without completed
tools, new and already-dirty file edits, read-only completion, bounded higher
limits, cancellation and explicit new-Assignment retry. Native ready checks also
reject read-only-only completion of write tasks, allow explicit inspection-only
completion, retain verified writes through a successful read-only review, and enforce
inspection-only scope even through an explicitly authorized fallback.
Status cases cover a
busy Worker without an answer report, original Feishu message routing,
changed-text/state deduplication, a fresh question receiving current state,
pause/resume delivery, unchanged technical answer gating, context/nonhuman/
unrelated rejection, and English queued/idle/delivery failure snapshots.

## Evidence limits and deployment advice

The incident's 43 calls / 972350 tokens / $1.146632 with no target file, followed
by 3 calls / 11543 tokens / $0.04638, are supplied incident facts. This checkout
contains no original Ticket transcript, receipt/effect log or CLI termination
record for `d164fd31ac9031a8d7323813e26d70a1`. We cannot independently attribute
the exact loop to permissions, repeated reads, internal retries or another
cause, nor conclude that Feishu transport suppressed an already queued reply.
The confirmed code defects are the loose default, missing write evidence,
and busy-Worker status-answer gate.

12 tool-loop turns do not imply 12 model calls or a hard dollar ceiling. Native
CLI internals can retry; terminal usage may be absent after forced termination.
Metadata evidence proves observed file activity, not correct content or that a
specific requested target was implemented. Review actual target files/diffs
before reporting ready. Ignored-only writes fail verification. A no-op write
request must be reviewed or performed as read-only inspection rather than
being claimed as a verified write. Existing inspection Tickets lacking the new
explicit `readOnly` flag will need reacceptance with correct scope before they
can complete through the inspection-only path; do not switch modes to bypass it.

State answers require the main Session to process the existing follow-up;
there is no independent SLA or classifier. Text is a snapshot at enqueue time.
Pause, unavailable transport and earlier pending messages still delay delivery
under native Outbox rules. Future deployment should first validate one ordinary
write, one busy-Ticket status question and native receipt deduplication in a test
environment, without replaying the expensive loop. Verify the production CLI
version and that configured Prompt overrides do not retain the old stop-only
rule. Deployment and any production changes require a separate operation.
