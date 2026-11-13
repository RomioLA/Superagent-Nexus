---
name: dsh-superagent-multistep-development
description: Plan, implement, and verify dependent development steps within one explicitly authorized Ticket.
---

Plan, implement, and verify dependent development steps within one explicitly authorized Ticket.

## Read and plan

1. Read the original assignment, referenced requirements and acceptance criteria. Inspect the relevant code and repository instructions. Record the authorized scope, deliverable and stop conditions. Follow the Ticket scope and Delivery requirements.
2. Break the work into small steps with observable outcomes. Use `todo_write` to record the steps in dependency order, naming any prerequisite and the check that will show each step is complete. Keep all steps in this Ticket.

## Implement, check and continue

1. Mark the first unblocked step in progress. Implement it in the Ticket directory and check the actual diff and relevant behavior. Fix failures caused by the change and rerun the affected checks.
2. Mark a step complete when its check provides evidence. Start the next unblocked step in the same Session without waiting for a continuation message. A progress update can record evidence while you continue working. For a background check, follow the Work instructions and inspect its result when the Session wakes.
3. Use native `subagent` when independent work warrants it and the Ticket allows it. Give each subagent a bounded scope and expected evidence. Assign disjoint files to concurrent writers and verify their results before marking work complete. Keep dependent steps in order.
4. Continue while work is authorized and feasible. Honor a human hold or stop and the Ticket's existing scope limits. If a prerequisite is missing, finish other authorized work that can proceed. Record the missing prerequisite and any attempted remedy.

## Review and report

Review the combined diff against the original acceptance criteria and run the relevant checks for the integrated change.
Call `orchestrator_report` with the resulting state and a summary of completed steps, verification results, remaining work and any deviations from the requirements. Include the exact blocker and any required human action when applicable.
Use `ready` only when the authorized deliverable is complete and verified. Follow the existing Work and Handoff instructions for other outcomes.
