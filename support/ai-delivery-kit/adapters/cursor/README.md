# Cursor Support

AI Delivery Kit support for Cursor has two parts:

- A readable package containing `core/`, `artifacts/templates/`, `prompts/`, `guides/`, and `kit.yaml`.
- A project rule under `.cursor/rules/` that tells Cursor when to read that package.

## Install For Cursor

```bash
./install.sh cursor --validate
```

Default destinations:

```text
<AI Delivery Kit repo root>/.cursor/skills/
<AI Delivery Kit repo root>/.cursor/ai-delivery-kit/
```

## Write Cursor Project Rule

Run this from `ai-delivery-kit` and point it at the business project that should use AI Delivery Kit:

```bash
./install.sh cursor --validate --workspace /path/to/workspace
```

This writes:

```text
/path/to/workspace/.cursor/rules/ai-delivery-kit.mdc
```

The rule points Cursor to the project-local `.cursor/ai-delivery-kit` package and asks it to read `core/`, `artifacts/templates/`, and `prompts/` only when the task is related to delivery artifacts or review checkpoint work.

For advanced usage, `--write-cursor-rules /path/to/workspace` and `AI_DELIVERY_KIT_CURSOR_DEST` are still supported.

## Maintainer Mode

When editing AI Delivery Kit itself, use symlink mode:

```bash
./install.sh cursor --mode link --validate --workspace /path/to/workspace
```

## Notes

- Cursor project rules are workspace-specific, so each business project should have its own `.cursor/rules/ai-delivery-kit.mdc`.
- The AI Delivery Kit package is the source of truth. Cursor rules only route the task to the right files.
- The optional Codex-to-Cursor handoff is only for development engineers and is not a mandatory review checkpoint process.
