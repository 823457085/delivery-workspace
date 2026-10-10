---
name: codex-cursor-handoff
description: Plan engineering work in Codex, delegate implementation to Cursor Agent, and verify the result in Codex. Use when the user says to hand work to Cursor, let Cursor execute, use Cursor CLI/Agent, have Codex plan and Cursor implement, or asks for Codex-to-Cursor collaboration on development tasks. This is a convenience skill for development engineers, not a mandatory AI Delivery Kit review checkpoint.
---

# Codex Cursor Handoff

**AI Delivery Kit**: `ai-delivery-kit/core/local-ai-collaboration.md`

## Overview

Use Codex as the planner and reviewer. Use Cursor Agent as the implementation worker only when the user explicitly wants Cursor to execute development work. Keep the workflow automatic when possible: do not stop after producing a prompt for manual copy/paste unless Cursor Agent is unavailable or the user asks for a manual handoff.

This skill is only for development engineers doing code work: implementation, defects, frontend interaction changes, refactors, or Cursor-result review. It is not a product/test workflow and is not a Gate hard requirement.

## Golden Path

1. Read the repository before planning. Identify the target repo, existing patterns, package manager, build/test commands, and likely files.
2. Write a concise implementation handoff under `.ai-handoff/` in the target repo:
   - `.ai-handoff/current-task.md`: scope, constraints, implementation steps, files likely involved, and forbidden changes.
   - `.ai-handoff/acceptance-checklist.md`: concrete checks Codex will use during review.
3. Run Cursor Agent directly when available:
   ```bash
   cursor agent --print --trust --force --model composer-2.5 --output-format stream-json --stream-partial-output --workspace <repo> "<read .ai-handoff/current-task.md and .ai-handoff/acceptance-checklist.md; implement only the requested batch; do not commit or push; write .ai-handoff/cursor-result.md>"
   ```
4. Keep the Cursor session open until it exits. Poll output; do not leave a running agent session.
5. Review Cursor's result file and inspect the actual diff. Do not trust a success summary alone.
6. Run Codex-side verification commands. Prefer the repo's commands; if package tools are missing, use the repo-compatible fallback, for example `npx pnpm <script>`.
7. Fix small issues directly if clearly within scope; otherwise produce a focused follow-up handoff for Cursor.
8. Final response must say what Cursor changed, what Codex verified, what warnings remain, and whether commit/push was intentionally skipped.

## Model Selection

- Prefer `composer-2.5` for stable implementation work.
- Do not use `auto` for planned engineering handoffs; it makes results harder to reproduce.
- Do not use `composer-2.5-fast` by default. Use it only when the user explicitly asks for the fast model.
- Check available models with `cursor agent models` when unsure.
- Confirm login with `cursor agent status` if Cursor Agent fails unexpectedly.

## Handoff Rules

- Write handoff files before invoking Cursor so the plan is versioned in the repo and easy to audit.
- Make Cursor read the files instead of embedding a huge prompt in the CLI command.
- Use batches for large refactors. Example: Batch 1 = page structure and interaction fixes; Batch 2 = state-machine rewrite. Tell Cursor explicitly which batch to execute.
- Each handoff must state the user-visible outcome, exact allowed scope, explicit non-goals, likely files, acceptance commands, and manual/browser checks when UI behavior is involved.
- When the user says the project is still in testing or has no historical burden, say so in the handoff and prefer one canonical model/name/API over compatibility shims for old behavior.
- For backend/frontend coupled changes, include the API/DTO path in the acceptance checklist so Cursor cannot finish after changing only one side.
- Include hard constraints:
  - Do not commit.
  - Do not push.
  - Do not change backend API contracts unless requested.
  - Do not broaden scope into unrelated refactors.
  - Write `.ai-handoff/cursor-result.md` with changed files, checks run, skipped checks, and residual risks.

## Task Packet Template

Keep handoff files short, but make them concrete enough that Cursor can work without guessing.

`current-task.md` should include:

- Goal: one or two sentences describing the user-visible outcome.
- Scope: repos, modules, pages, packages, or APIs in play.
- Non-goals: explicit things Cursor must not touch.
- Compatibility posture: whether to preserve legacy contracts or remove old names/branches because the project is still in testing.
- Current observations: facts Codex learned from reading the code, not speculation.
- Implementation steps: a small ordered list, preferably one batch only.
- Expected files: likely files or directories to inspect first.
- Verification hints: commands Cursor should try before writing the result.

`acceptance-checklist.md` should include:

- Behavior checks that must be true after the change.
- Compatibility checks, including API contracts, data migrations, or UI states when relevant.
- Verification commands Codex will rerun.
- Manual or visual checks that cannot be fully automated.
- Residual risks Cursor must report rather than hide.

Cursor's CLI prompt should tell it to read both files, implement only the batch, avoid commits/pushes, and write `cursor-result.md` with changed files, checks run, skipped checks, and residual risks.

## Long Task Loop

For broad work, use small iterations instead of one giant handoff.

1. Codex reads the repo and writes a batch-level task packet.
2. Cursor implements exactly that batch.
3. Codex waits for Cursor to exit, reads `cursor-result.md`, inspects the diff, and reruns critical checks.
4. Codex fixes small obvious issues directly when they are inside the agreed scope.
5. If more work remains, Codex writes the next batch task packet and repeats.

Do not declare success until Codex has verified the final diff, not just Cursor's summary. If the user asks for a "long task, small steps" workflow, report progress by batch and keep the user informed after each verification point.

For long productization work, define the whole target state once, then execute narrow batches. Each batch should have one observable outcome and one rollback/follow-up decision point. Avoid vague batches such as "optimize the page"; prefer "replace role task cards with backend-driven action queue and verify product/dev/QA roles render different next actions".

## Pitfalls From Real Usage

- "交给 Cursor" means run Cursor Agent when possible, not merely generate text for the user to paste.
- Cursor may claim checks passed; Codex must rerun or independently verify critical checks.
- `pnpm` may not be globally installed. Try `npx pnpm <script>` before changing project tooling.
- Network sandboxing may block `npx`; request approval and rerun rather than treating it as a code failure.
- Cursor Agent commands may continue running after useful output. Always poll until the process exits.
- Some Cursor models can hit quota. Retrying with `composer-2.5` is usually better than stopping or switching to `auto`.
- If Cursor leaves child processes running, inspect process output and stop only the stuck child after confirming Cursor has finished writing its result.
- Keep `.ai-handoff/` concise. Overly long handoffs make Cursor drift.
- If the current worktree already has unrelated modified files, preserve them. Review only the files relevant to the batch and do not revert user or previous-session changes.
- Do not make the user manually shuttle prompts between apps unless automation is blocked.
- Do not assume Cursor's implementation matches the plan; inspect source files and tests.
- Do not leave the final answer at "Cursor has a plan"; the deliverable is implemented code plus Codex verification.
- Do not describe this as a team-wide mandatory AI Delivery Kit review checkpoint.

## Cursor Agent Sandbox/Auth Failures

If `cursor agent` fails in the sandbox with errors such as `SecItemCopyMatching failed -50`, treat it as a likely macOS Keychain or Cursor login-state access issue. Follow the current sandbox escalation rules if direct Cursor execution is still appropriate.

If escalation is denied because Cursor Agent may read private repository files and send context to external Cursor services, do not keep retrying or invent a bypass. Explain that this is an execution-environment and data-governance boundary, not a skill failure.

Fallback options:

- Ask the user to run Cursor manually against `.ai-handoff/current-task.md` and `.ai-handoff/acceptance-checklist.md`, then have Codex review the diff and verify checks.
- Offer to have Codex implement the scoped task locally instead.
- If the user or organization later approves Cursor Agent execution for the repository, resume the normal Golden Path.

## Verification Checklist

Use the acceptance checklist plus repo-specific commands. For frontend repos, typical checks are:

```bash
npx pnpm typecheck
npx pnpm lint
npx pnpm test
npx pnpm build
```

Also inspect:

- `git status --short`
- key changed files with `sed` or `rg`
- line counts for files that were supposed to shrink
- any result file Cursor wrote under `.ai-handoff/`
- DTO/API mapping paths when backend and frontend both changed; make sure data actually reaches the UI.
- generated artifacts, lockfiles, and build outputs so accidental churn is visible.

For UI work, verify the actual rendered page with a browser when browser tooling is available. Prefer Playwright or the in-app browser for screenshots and responsive checks. If browser execution needs elevated permissions, request them. If no browser tooling is available, state that visual verification remains for deployment/manual review.

For frontend UX work, acceptance should cover both code quality and user flow:

- key states: empty, loading, ready, error, degraded, and success;
- primary next action is visible without reading documentation;
- fallback/manual paths are valid when the automated path is optional;
- text fits at desktop and mobile widths;
- `lint`, `typecheck`, `test`, and `build` pass unless the repo has a different standard.

## Example User Requests

- "帮我规划 ai-delivery-hub-web 前端重构，交给 Cursor 做"
- "这次你直接让 Cursor 执行，完成后你来验收"
- "Codex 负责方案，Cursor 负责开发"
- "把这个修复下发给 Cursor Agent，别只给我提示词"
