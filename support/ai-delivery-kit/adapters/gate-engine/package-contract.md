# Embedded Gate Engine Package Contract

The embedded Gate Engine should load AI Delivery Kit as a read-only package.

Required inputs for review checkpoint execution:

| Resource | Path |
|----------|------|
| Package entry | `README.md` |
| Checkpoint rules | `core/gates.md` |
| Checkpoint policy | `core/gate-policy.md` |
| Checkpoint result schema | `artifacts/schemas/gate-result-schema.md` |
| AI review prompt | `prompts/ai-gate-engine.md` |
| Review report template | `artifacts/templates/gate-report.md` |

New integrations should use `ai-delivery-kit` as the canonical package path.
