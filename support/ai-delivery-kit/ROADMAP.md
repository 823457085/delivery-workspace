# AI Delivery Kit Roadmap

AI Delivery Kit is the company-level source of truth for AI-assisted product, development, and QA delivery. It owns shared rules, templates, prompts, skills, and tool adapters. AI Delivery Hub, Codex, Cursor, and the embedded gate engine should consume this package instead of duplicating rules.

## Current Baseline

- The target Git repository is `git@git.example.com:team/ai-delivery-kit.git`.
- Package root is flat: `kit.yaml`, `core/`, `artifacts/`, `prompts/`, `skills/`, `adapters/`, `governance/`, `tests/`, and `install.sh` are at repository root.
- Package contains `core/`, `artifacts/templates/`, `prompts/`, `skills/`, `adapters/`, `governance/`, `install.sh`, and `tests/validate-package.sh`.
- Codex and Cursor adapters exist and can write workspace-level guidance.
- AI Delivery Hub can create requirements, run R0, create Work Items, dispatch them to local Codex through `ai-delivery-bridge`, accept Draft Revisions, and run review again.
- The gate engine is embedded in AI Delivery Hub so deployment can converge to one service and one database.

## P0a: Repository Shape Convergence

Goal: make the AI Delivery Kit repository itself the installable package, without requiring users or services to know historical folder names.

Scope:

- Keep the repository root as the installable package root.
- Keep experimental delivery and requirement exploration material outside the active package repository.
- Use AI Delivery Hub Nacos `gate_engine.kit_repo.path: "."` (runtime YAML key `review_hub:` retained).
- Keep `gate_engine.kit_repo.target_path: ai-delivery-kit` and `review_hub.runner.kit_path: ai-delivery-kit` so runtime workspace layout remains stable.
- Keep `install.sh both --validate --workspace <workspace>` as the only onboarding command users need.

Acceptance:

- `kit.yaml` exists at repository root.
- `./tests/validate-package.sh` passes from repository root.
- `./install.sh both --validate --dry-run --workspace /tmp/ai-delivery-kit-smoke` works from repository root.
- AI Delivery Hub startup log shows `kit_repo_synced path=. target_path=ai-delivery-kit`.
- No active daily workflow depends on retired package layouts or separate Gate Engine services.

## P0: Naming, Deployment, And Config Convergence

Goal: make user-facing naming and deployment converge on AI Delivery Kit, AI Delivery Hub, and an embedded Gate Engine.

Scope:

- Use `AI Delivery Kit` as the package name everywhere user-facing.
- Use `AI Delivery Hub` as the platform name.
- Use `ai-delivery-bridge` as the local bridge command.
- Make AI Delivery Hub call the embedded gate engine with `kit_path`.
- Use one Nacos Data ID for the unified service.
- Use one MySQL database for AI Delivery Hub workflow tables and gate run tables.
- Keep only the implementation libraries needed by the embedded Gate Engine.

Acceptance:

- User-facing docs and configuration use AI Delivery Kit / AI Delivery Hub names and a single service deployment.
- `make build-docker-push ENV=test WEB_REPO=../ai-delivery-hub-web` builds one image containing API, web, MCP, and embedded gate engine.
- Runtime log shows `static_web=true`, `runner.mode=embedded`, and no standalone runner dependency.
- `/requirements` returns the SPA HTML after login.
- Existing R0 requirement flow still works end to end.

## P1: Package Contract And Installation

Goal: make AI Delivery Kit installable and usable by every product, development, and QA workspace.

Scope:

- Treat `kit.yaml` as the package manifest.
- Keep `core/` as policy authority.
- Keep `artifacts/templates/` as artifact authority.
- Keep `prompts/` as execution prompt authority.
- Keep `skills/manifest.tsv` as skill registry.
- Make `install.sh both --validate --workspace <workspace>` the default onboarding command.
- Document how Codex and Cursor discover the package.
- Document how AI Delivery Hub and the embedded gate engine load the package.

Acceptance:

- `./tests/validate-package.sh` passes.
- `./install.sh both --validate --workspace /tmp/ai-delivery-kit-smoke` writes Codex and Cursor guidance without manual edits.
- A new workspace can ask Codex or Cursor to work on PRD / tech design / test plan and the tool reads package material instead of relying on memory.
- AI Delivery Hub config can point at a git repo, ref, and `kit_path`.

## P2: R0 Closed Loop Stabilization

Goal: make PRD review and AI-assisted revision feel reliable enough for pilot users.

Scope:

- AI Delivery Hub requirement creation and editing.
- Source precheck as automatic detail-page capability.
- R0 gate run, Findings, and review pack.
- Work Item creation, dispatch to local Codex, MCP progress reporting.
- Draft Revision diff, approval, publish, and R0 review again.
- Clear stale / failed bridge job recovery.
- Confluence archive only after platform artifact is approved.

Acceptance:

- A new platform requirement can go from blank draft to R0 Fail, AI revision, Draft Revision approval, R0 rerun, and ConditionalPass/Pass without leaving the main page.
- Bridge restart does not permanently block redispatch.
- Work Item panel always shows current item, status, progress, and recovery action.
- R0 result is explainable through Findings and linked artifact changes.

## P3: Extend To R1 And G2

Goal: bring development and QA into the same artifact workflow.

Scope:

- R1a: development PRD/prototype challenge.
- R1b: QA PRD/prototype challenge.
- G2a: tech design coverage review against PRD.
- G2b: test plan coverage review against PRD and tech design.
- Skills and templates for dev-prd-review, qa-prd-review, tech-design, and test-plan.
- AI Delivery Hub Work Items per role.

Acceptance:

- Developers can create or revise `tech-design.md` from platform context with Codex.
- QA can create or revise `test-plan.md` from platform context with Codex.
- R1/G2 Findings can be traced back to PRD sections, AC IDs, BE/NFR IDs, and artifacts.
- Gate results remain advisory first until the pilot team agrees to enforcement.

## P3b: GitLab MR Review And Engineering Quality Standardization

Goal: connect private GitLab code submission with AI Delivery Hub review while making code review, unit test, API contract, DB change, self-test evidence, and frontend quality expectations explicit and reviewable.

Scope:

- Add GitLab Webhook Receiver for merge request, push, and pipeline events.
- Associate MR/branch/commit with a Hub requirement by requirement ID, branch name, MR title, or manual binding.
- Create code review runs in Hub and show them under the requirement's development phase.
- Pull MR diff, changed file list, CI status, and unit test result.
- Review code changes against `core/code-review-standard.md`, `core/unit-test-standard.md`, `core/api-contract-standard.md`, `core/db-change-standard.md`, `core/self-test-evidence-standard.md`, `core/frontend-quality-standard.md`, `tech-design.md`, `test-plan.md`, `implementation-plan.md`, `self-test-report.md`, and `pr-checklist.md`.
- Write advisory comments back to GitLab MR; keep blocking mode disabled during pilot.

Acceptance:

- Updating an MR creates or updates one active Hub code review run for the linked requirement.
- Core business, amount, permission, state machine, public component, and bug fix changes without unit tests are reported as findings.
- Bug Fix without a failing reproduction test is reported as blocker in advisory mode.
- MR comments link back to Hub and summarize blocker/major findings.
- Developers can see unit test gaps before G3 submit.
- API, DB, frontend state, and self-test evidence gaps are reported as advisory findings before G3 submit.

## P4: Governance And Rollout

Goal: make the kit maintainable by the organization, not just one project.

Scope:

- Owners for product, development, QA, and platform integration.
- Contribution policy for rules, templates, prompts, and skills.
- Versioning and changelog.
- Pilot checklist and onboarding guide.
- Compatibility notes for Codex, Cursor, AI Delivery Hub, and the embedded gate engine.

Acceptance:

- `governance/owners.yaml` has named owners.
- Each package change updates `CHANGELOG.md`.
- The pilot team has a short onboarding flow: install kit, configure AI Delivery Hub, pair bridge, run first R0.
- Deprecated concepts are documented once and not shown in the daily workflow.

## P5: Metrics And Improvement Signals

Goal: make AI Delivery Kit improvements data-driven instead of relying on anecdotal feedback.

Scope:

- Define common metrics consumed by AI Delivery Hub dashboards.
- Track repeated finding categories and map them back to templates, prompts, or rules.
- Define pilot review cadence and reporting format.
- Provide metrics glossary for product, development, QA, and team leads.

Acceptance:

- AI Delivery Hub can explain team-level quality and flow metrics using Kit terminology.
- Repeated blocker/major categories have an owner and improvement proposal path.
- Pilot reviews can compare first-pass rate, rework count, lead time, and issue distribution before and after adoption.

## P6: Knowledge Flywheel

Goal: convert delivery outcomes into reusable knowledge, examples, and skills that every team can consume.

Scope:

- Excellent artifact examples for PRD, tech design, test plan, self-test report, release plan, and outcome review.
- Common issue playbooks: why the issue happens, how to fix it, which template/rule should change.
- Role-based skills and prompts for product, development, QA, and team leaders.
- Contribution workflow from Hub Findings to Kit pull requests.

Acceptance:

- A repeated Hub Finding can become a Kit rule/template/prompt improvement with traceable rationale.
- New team onboarding can be completed through the Kit quick start and Hub first-run guide.
- Kit releases explain what changed, why it changed, and which Hub metrics or pilot feedback triggered it.

## Immediate Next Actions

1. Deploy AI Delivery Hub with `gate_engine.kit_repo.path: "."`.
2. Finish P0 naming cleanup in active platform README, Nacos docs, UI labels, and externally visible gate result fields.
3. Quarantine standalone runner docs/config as legacy troubleshooting material only.
4. Run package validation, platform tests, single-image Docker smoke, and one pilot R0 end-to-end flow after every deployment.
5. Expand R1/G2 only after the R0 local Codex revision loop is stable for pilot users.
6. Add GitLab MR Hook review in advisory mode and use `core/unit-test-standard.md` as the code-review testing authority.
7. Start collecting repeated Findings as input for the P5/P6 improvement queue.

## Detailed Hub Execution Plan

The implementation-level roadmap for AI Delivery Hub lives in:

```text
../ai-delivery-hub/docs/DELIVERY_ROADMAP.md
```

Use that document to drive Cursor/Codex implementation planning and phase acceptance. This Kit roadmap remains the package and rollout authority; the Hub roadmap is the product and engineering execution plan.
