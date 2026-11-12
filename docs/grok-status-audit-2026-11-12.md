# Grok verification and native behavior review

Date: 2026-11-12 (Asia/Hong_Kong).
The follow-up review started from clean `codex/magpie-cost-routing`,
`de7d9908fc766286c6ec896caf15817637b0a449`, and reviews the restrictions introduced
by `deb200a` and `de7d990`. This document supersedes their earlier restrictive
recommendations. Only the development checkout is changed; no production
checkout/database changes, deployment, restart, push, merge or real Grok model
experiment is involved.

## Sources and baseline

Official upstream main was rechecked through GitHub and is still
[`8c32a9d`](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4).
Its `src/core/assignments.ts`, `src/core/tickets.ts`, `src/core/replies.ts`,
`src/app/notices.ts`, `src/app/outbox.ts` and `src/executor/dsh.ts` already own
reports, recovery, follow-ups, replies, cancellation and delivery. The native
report lifecycle supports inspection/no-change work; it does not require a new
inspection authorization marker or a write on every successful turn. Upstream
has no Grok adapter or external-CLI dollar budget to enable.

Installed Grok remains 1.0.80; `grok --no-auto-update --help` was rechecked without
model work. The official [headless documentation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)
provides `--max-turns`, JSON stop reasons, usage and resume/continue facilities.
The limit counts agent/tool-loop turns, not model calls or dollars. There is no
official requirement to justify a limit above 12 or to lock an Assignment after
one error. CLI help does not prescribe a 50-turn default: **50 was already this
custom adapter's configuration in `0734f67`**, not an upstream or CLI default.

## Item-by-item decision

| Earlier addition | Decision | Evidence/reason |
| --- | --- | --- |
| Default 12 turns | Withdraw; restore the adapter's existing 50 | No actual task validation establishes a universal 12-turn policy |
| Adapter ceiling of 50 and `limit_reason` above 12 | Withdraw; allow positive `max_turns` directly, including values above 50 | Reuse the official parameter rather than add an execution approval policy |
| Any failure locks the current Assignment | Delete lock and dynamic Assignment callback | DSH and CLI already own error recovery; an ordinary failure does not prove another call must be prohibited |
| Prompt/error text forbids retry or increasing a stopped run's limit | Withdraw | No new retry governor; the existing Worker decides recovery with actual failure/partial-change evidence |
| `harness.readOnly` acceptance flag, mode/fallback restrictions and mandatory reacceptance | Remove | No incident evidence showed a read-only bypass; requiring a new acceptance flag harms ordinary native inspection work |
| Every Grok Ticket needs writes before `ready` | Remove special gate; retain the pre-existing successful-Harness gate | Inspection/no-change tasks may finish under native reporting; task correctness remains the Worker's review responsibility |
| Delete an earlier successful Harness record before every new Grok call | Remove | A later failure/no-op does not establish that an earlier actual edit vanished; retain native execution history semantics |
| Every write call must have both completed-edit events and workspace changes | Relax; actual workspace changes are the verification evidence, tool counts are diagnostic | Stream metadata can be incomplete; a real observed edit must not fail solely because its completion event was absent |
| No-change write throws and requires explicit retry | Replace with `status: unverified` and truthful host summary | This prevents a model-only write claim from becoming a new success, without making inspection/no-op results an execution ban |
| Recognize official `max_turns_reached` | Keep | A CLI limit stop is incomplete, as the original non-`end_turn` check already requires; it must not be called successful |
| Per-run mode and write-evidence metadata | Keep descriptive only | They show observed facts, not another Ticket policy or state manager |
| Human/source/context checks and deterministic Outbox key for status answers | Keep unchanged | Directly fixes the confirmed busy-Worker status-answer gap through native Reply/Ticket/Outbox |

## Write verification and normal recovery

For write-mode CLI completion, the existing Git inventory and file metadata
snapshot record observed changes, independently of the model's completion text.
A real observed change is accepted even without a diagnostic edit-completed
message. If no change is observed, the tool returns `unverified`, the host's
summary states that writing is not verified, and the original response is kept
separately as `model_summary`. An unverified result does not create a new
successful `harnessRun`, so a first model-only write claim cannot satisfy the
existing `ready` execution check.

The adapter does not retry automatically and does not prohibit a later call.
CLI errors/limit stops/cancellation still report their actual failure; the same
binding can be used again through the existing tools. A previous successful
record is preserved after failure or unverified/no-op output. Read-only runs
remain ordinary successful inspections and can report `ready` without another
acceptance flag or file write. No new parser tries to infer task intent from
keywords. Workers must review the actual target before claiming it was written;
a successful inspection is not proof that it was edited.

File activity does not prove semantic correctness or a particular target's
contents. Git-ignored/unlisted changes may be unverified and can be inspected
through the normal read-only path; no extra reacceptance or Assignment retry is
required. A preserved historical success is not a certification of the current
file contents. Native Worker review and relevant checks still decide completion.

## Retained controls and status reply scope

The pre-existing per-Ticket credential isolation, sandbox/tool permissions,
protected paths, output capture limit, 150-second read timeout, 480-second write
timeout, and process-group SIGTERM/SIGKILL cancellation are unchanged. JSON
completion and real model-usage verification remain. The adapter does not invent
a hard dollar budget or its own billing/retry system.

Feishu status behavior is unchanged from the minimal fix: explicit status
questions use existing `orchestrator_reply purpose=answer, status_only=true`;
current text comes from native `ticketStage`, and delivery uses the original
human trigger's channel and the existing durable Outbox with a deterministic
Ticket/trigger key. Technical answers still use the Worker's
`reply_to_trigger_id` authorization. Ordinary progress stays internal. A running
snapshot does not certify health/success, and native pause/transport conditions
still affect delivery.

## Validation

Focused simulated-CLI and native runtime tests cover same-binding retries after
limits/errors/cancellation, positive higher official limits, honest unverified
writes, real edits without completion events, read-only completion without a
new flag, preserved earlier successful work, authorized native fallback,
status answers and deduplication. No real model loop is run.

Final verification: 19 related Vitest files passed, **373 tests passed and 2
existing opt-in AGY live smoke tests were skipped**. The suite includes Grok
arguments/process simulation, native routing, status replies, follow-ups, P0
notification integration, AGY/Codex adapters, CLI isolation/security, Outbox,
core engine/runtime, Prompt surfaces, documentation, delivery, retry health and
queue. `pnpm typecheck`, `pnpm build`, and `git diff --check` passed.
