# AI Delivery Hub Package Loader Contract

AI Delivery Hub should treat AI Delivery Kit as a package with stable resource roots.

Required roots:

| Root | Purpose |
|------|---------|
| `core/` | Review checkpoint rules, lifecycle, roles, security, `checkpoints.yaml` |
| `artifacts/templates/` | Editable artifact templates |
| `artifacts/schemas/` | Structured contracts |
| `prompts/` | AI execution prompts |
| `skills/` | Skill metadata for local AI tools |

Recommended lookup order:

1. Explicit configured package path.
2. Installed package path at `ai-delivery-kit`.

AI Delivery Hub should store package id and version with review tasks so Draft Revisions are reproducible.
