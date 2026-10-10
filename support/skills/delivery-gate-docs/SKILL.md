---
name: delivery-gate-docs
description: Create or review a formal AI Delivery Kit artifact or gate record, including PRD, design, test, implementation, release, and acceptance documents.
---

# AI Delivery Kit

Use this skill for a requested formal delivery artifact or AI Delivery Hub revision. It is a router: read only the selected prompt, template, and standards that affect the requested artifact.

## Locate the kit

Use `AI_DELIVERY_KIT_ROOT` when set; otherwise prefer `${CODEX_HOME:-$HOME/.codex}/ai-delivery-kit`, then a `kit.yaml` in or beside the current repository. Resolve all paths from that root.

## Route the request

| Requested output | Read |
| --- | --- |
| PRD, prototype notes, review minutes | `prompts/S0-PRD.md`, `S0-prototype-notes.md`, or `S1-review-minutes.md` and its matching template |
| PRD review | `R0-prd-self-check.md`, `R1a-dev-prd-review.md`, or `R1b-qa-prd-review.md`; load `prd-prototype-challenge` for R1 |
| Technical design | `S2a-tech-design.md`, `artifacts/templates/tech-design.md`, and `tech-design-coverage-review` when auditing |
| Test plan or cases | `S2b-test-plan.md` or `S2b-test-cases.md`; load `test-plan-coverage-review` when auditing |
| Implementation, self-test, test, acceptance, release, outcome | the matching `G3-implementation-plan.md`, `S3-self-test-report.md`, `S4-test-report.md`, `S5-acceptance-record.md`, `G8-release-plan.md`, or `G9-outcome-review.md` |

For the full mapping, read `prompts/README.md`. Read `core/code-review-standard.md`, `unit-test-standard.md`, `api-contract-standard.md`, `db-change-standard.md`, `self-test-evidence-standard.md`, or `frontend-quality-standard.md` only when the deliverable covers that concern.

## Work rules

- Use supplied sources and repository evidence; mark missing facts and proposed contracts instead of inventing them.
- Preserve the selected template structure and report coverage, open items, and evidence appropriate to its gate.
- A local document is not a passed gate, publication, Jira mutation, or deployment. Perform those actions only when the user requested them and verify the result by readback.
- For AI Delivery Hub work items, submit only the requested Draft Revision; do not publish a formal document or write Confluence unless explicitly asked.
