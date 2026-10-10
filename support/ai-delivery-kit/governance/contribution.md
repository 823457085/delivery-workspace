# Contribution Guide

AI Delivery Kit is a shared package. Product, development, QA, and platform maintainers can contribute, but every change should keep the package usable by Codex, Cursor, AI Delivery Hub, and AI Delivery Gate Engine.

## Contribution Types

| Type | Examples | Required Review |
|------|----------|-----------------|
| Rule | Gate policy, lifecycle, security rules | Product + Dev + QA owner |
| Template | PRD, tech design, test plan | Corresponding role owner |
| Prompt | Generation or review prompt | Corresponding role owner |
| Skill | AI task entrypoint | Platform + role owner |
| Adapter | Codex, Cursor, AI Delivery Hub, AI Delivery Gate Engine integration | Platform owner |

## Requirements

1. Update `CHANGELOG.md`.
2. Keep file paths stable when possible.
3. Do not duplicate rules across tools; update `core/` and let adapters reference it.
4. Run `./tests/validate-package.sh`.
5. Include before/after examples when changing templates or prompts.

## Versioning

- Patch: wording fixes, examples, non-breaking prompt improvements.
- Minor: new templates, prompts, skills, or optional Gate checks.
- Major: breaking Gate changes or template structure changes.
