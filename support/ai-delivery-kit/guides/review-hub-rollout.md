# AI Delivery Hub Rollout Checklist

This checklist keeps AI Delivery Kit and AI Delivery Hub aligned during the current pilot. AI Delivery Hub operates on **requirements**; product, development, and QA collaborate on the same requirement with role-specific artifacts. Every item should be easy to verify after a deployment.

> File name `review-hub-rollout.md` is retained for link stability; content describes AI Delivery Hub rollout.

## 1. Package Source

Current target repository:

```text
git@git.example.com:team/ai-delivery-kit.git
```

The package root is the repository root:

```text
kit.yaml
core/
artifacts/
prompts/
skills/
adapters/
governance/
tests/
install.sh
```

Acceptance:

- `kit.yaml` is the package manifest.
- `./tests/validate-package.sh` passes.
- `./install.sh both --validate --dry-run --workspace /tmp/ai-delivery-kit-smoke` passes.
- New public docs use "AI Delivery Kit" and "AI Delivery Hub", not legacy product-facing names.

## 2. Hub Runtime

Recommended deployment is one AI Delivery Hub service (internal binary name `review-hub`):

```text
review-hub = API + Web + MCP + Local Bridge APIs + embedded Gate Engine
```

Acceptance:

- Nacos uses one Data ID: `ai-delivery-hub.yaml`.
- No new standalone runner Pod is deployed.
- One MySQL database contains AI Delivery Hub workflow tables and Gate Run tables.
- Startup logs include `static_web=true`, `runner_enabled=true`, and `mcp_enabled=true`.
- `/requirements` returns the SPA after login.

## 3. Kit Sync Config

Runtime config:

```yaml
review_hub:
  runner:
    kit_path: "ai-delivery-kit"
  gate_engine:
    kit_repo:
      repo: "https://git.example.com/team/ai-delivery-kit.git"
      ref: "main"
      path: "."
      target_path: "ai-delivery-kit"
```

Acceptance:

- `kit_repo.path` is `.` because `kit.yaml` is at repository root.
- `runner.kit_path` stays stable as `ai-delivery-kit`.
- The synced runtime workspace contains `ai-delivery-kit/kit.yaml`.

## 4. Local Codex Bridge

Required user flow:

```bash
./ai-delivery-bridge pair --url https://delivery.example.com --code <pair_code>
./ai-delivery-bridge doctor
./ai-delivery-bridge run
```

Acceptance:

- `doctor` reports `codex_binary: true`, `mcp_configured: true`, and `heartbeat: ok`.
- Dispatching a Work Item creates or resumes a requirement-level Codex session.
- Hub page shows the current Work Item, progress, stale status, and recovery action.
- Bridge restart does not permanently block redispatch.

## 5. R0 Pilot Flow

End-to-end pilot path:

1. Create a requirement in AI Delivery Hub.
2. Trigger R0.
3. Review Findings.
4. Dispatch the Work Item to local Codex through `ai-delivery-bridge`.
5. Codex submits Draft Revision through MCP.
6. Human reviews Diff and approves/publishes the Draft Revision.
7. Trigger R0 again.

Acceptance:

- Source precheck runs automatically on the requirement detail page.
- R0 Fail / ConditionalPass / Pass is explainable through Findings.
- Draft Revision does not write Confluence automatically.
- Confluence archive happens only after the platform artifact is approved.

## 6. Next Expansion

After R0 stabilizes:

- R1a: developer PRD/prototype challenge.
- R1b: QA PRD/prototype challenge.
- G2a: tech-design coverage review against PRD.
- G2b: test-plan coverage review against PRD and tech-design.

Acceptance:

- Each new checkpoint has a template, prompt, skill, Hub action, and clear owner.
- Findings trace back to artifact sections and stable IDs.
- Pilot teams can use the flow without copying raw prompts unless the bridge is unavailable.
