---
name: ai-delivery-local-bridge-diagnostics
description: Diagnose and recover AI Delivery Hub Local Bridge, Codex MCP, AI revision task dispatch, progress reporting, and Draft Revision submission issues. Use when Hub shows local AI stuck, Bridge does not receive jobs, MCP is unauthenticated, duplicate Codex sessions appear, work items are stale, or local Codex/Bridge integration fails.
---

# AI Delivery Local Bridge Diagnostics

Use this skill for Hub -> Local Bridge -> Codex MCP failures. The goal is to identify where the chain broke and give a recoverable next action.

## Mental Model

The normal flow is:

1. Hub creates an AI revision task for a requirement.
2. User dispatches it to Local Bridge.
3. Bridge receives a bridge job.
4. Bridge starts or resumes Codex.
5. Codex uses `ai-delivery-hub` MCP to claim/read the task.
6. Codex reports progress through MCP.
7. Codex submits a Draft Revision through MCP.
8. Hub refreshes and shows the Draft Revision for human approval.

Do not assume Bridge heartbeat means the whole chain is healthy.

## First Checks

Collect:

- Hub URL and requirement id.
- Current user id.
- Bridge device id.
- AI revision task id.
- Bridge job id, if visible.
- Local Bridge command output.
- Codex MCP server name.

Then check:

```bash
./ai-delivery-bridge doctor
./ai-delivery-bridge run
codex mcp get ai-delivery-hub --json
```

If the project still uses an old MCP name from the pre-AI-Delivery-Hub era, treat that as a migration residue unless the user explicitly says it is intentional.

## Failure Classification

Classify the failure before fixing:

- `not_dispatched`: Hub has a task but no bridge job.
- `bridge_offline`: Hub cannot see a healthy device heartbeat.
- `job_received_not_started`: Bridge received the job but did not launch Codex.
- `codex_started_mcp_missing`: Codex launched but MCP server is not configured.
- `mcp_unauthenticated`: MCP exists but token is invalid.
- `task_claim_failed`: MCP can connect but cannot claim/read the task.
- `progress_missing`: task is running but no MCP progress arrives.
- `draft_missing`: Codex completed locally but Draft Revision is absent.
- `stale_in_progress`: Hub still thinks a task is running after Bridge/Codex died.
- `duplicate_dispatch`: multiple tasks/jobs/sessions were created for the same intended revision.

## Recovery Playbook

Use the least destructive recovery:

- Missing MCP: re-run Bridge pairing/setup if it manages MCP config; otherwise update Codex MCP config with the current token.
- Invalid token: regenerate/re-pair rather than editing random stale token values.
- Bridge restarted mid-task: ask Hub/Bridge to reconcile current device jobs before re-dispatching.
- Stale task: mark stale/retry through Hub-supported reset endpoint or UI action; do not edit DB directly unless explicitly asked.
- Duplicate dispatch: identify the newest valid task and ignore/cancel older waiting tasks.
- Draft submitted but UI stale: refresh detail data and check Draft Revision API before re-running AI.

## Codex Desktop Session Notes

If the user expects CLI runs to appear in Codex Desktop:

- Confirm `CODEX_HOME` used by Bridge matches the desktop app home, usually `~/.codex`.
- Confirm the resume command includes the correct working directory:
  ```bash
  codex resume --include-non-interactive -C <workspace_dir> <session_id>
  ```
- Search may find sessions before the sidebar shows them; sidebar visibility depends on Desktop indexing/state.

Do not promise Desktop sidebar placement unless verified.

## Evidence To Report

Report:

- Device status.
- MCP server status.
- Task status.
- Bridge job status.
- Last progress timestamp.
- Whether Draft Revision exists.
- Recommended next action.

Keep secrets out of the report.
