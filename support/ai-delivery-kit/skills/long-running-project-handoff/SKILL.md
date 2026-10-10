---
name: long-running-project-handoff
description: Preserve working memory for long-running engineering/product threads by maintaining concise handoff files. Use when a project conversation is long, context compaction is likely, a task spans Cursor/Codex/tool runs, or the user asks to continue in a new thread without losing state.
---

# Long Running Project Handoff

Use this skill when a task is likely to outlive the current context window. The goal is to make the next Codex turn or a new conversation able to continue without relying on chat history.

## Core Files

Create or update these files under the active workspace:

- `.ai-handoff/next-thread-brief.md`: stable entrypoint for a new thread.
- `.ai-handoff/session-state.md`: current execution state.
- `.ai-handoff/current-task.md`: active implementation or review task.
- `.ai-handoff/acceptance-checklist.md`: checks that define done.

Do not create a sprawling diary. Keep each file concise and operational.

## When To Update

Update handoff state when:

- The user says context is getting compressed.
- A task is delegated to Cursor or another tool.
- A long-running command starts or finishes.
- The direction changes materially.
- Before ending a turn with work still needing verification.
- Before suggesting a new thread.

## What To Record

Record only what helps continuation:

- Current goal in one or two sentences.
- Repositories and absolute paths.
- User decisions, constraints, and explicit non-goals.
- What has been done.
- What is currently running, including session IDs if any.
- Next verification commands.
- Known risks and unresolved questions.
- Where result files live.

Avoid copying long logs. Link to files or summarize key lines.

## New Thread Entry

`next-thread-brief.md` should include a copyable prompt:

```text
请先读取 /absolute/path/.ai-handoff/next-thread-brief.md，继续推进当前任务。
```

Also include links to deeper files such as `session-state.md`, result files, and long-term direction docs.

## Verification

Before claiming the handoff is ready:

- Read the generated handoff once.
- Check that paths are absolute or clearly rooted in the workspace.
- Check that the next action is explicit.
- Check that stale instructions are not presented as current truth.

## Pitfalls

- Do not store secrets, tokens, or private API keys in handoff files.
- Do not treat handoff files as formal product docs; they are working memory.
- Do not let handoff files replace real verification.
- Do not overwrite user-authored planning docs unless asked.

