# Adapters

Adapters connect AI Delivery Kit to specific tools.

| Adapter | Purpose |
|---------|---------|
| `codex/` | Install Codex skills and generate workspace `AGENTS.md` |
| `cursor/` | Install Cursor-readable package and generate `.cursor/rules/*.mdc` |
| `ai-delivery-hub/` | Describe how AI Delivery Hub loads kit resources |
| `gate-engine/` | Describe how the embedded Gate Engine loads kit resources |

Adapters should not redefine rules. They should point tools back to `core/`, `artifacts/`, `prompts/`, and `skills/`.
