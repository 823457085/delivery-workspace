# Codex Support

AI Delivery Kit should be installed into Codex as both:

- Skills: lightweight entrypoints that make Codex choose the right workflow.
- Package resources: `core/`, `artifacts/templates/`, `prompts/`, `guides/`, and `kit.yaml`, so Codex can read the authoritative rules and templates instead of relying on memory.

## Install For Codex

```bash
./install.sh codex --validate
```

Default destinations:

```text
~/.codex/skills/
~/.codex/ai-delivery-kit/
```

## Install And Write Workspace Instructions

Run this from `ai-delivery-kit` and point it at the business project that should use AI Delivery Kit:

```bash
./install.sh codex --validate --workspace /path/to/workspace
```

This writes `/path/to/workspace/AGENTS.md`, telling Codex where the installed AI Delivery Kit package is and when to apply it.

If the workspace already has `AGENTS.md`, merge the template manually or run:

```bash
./install.sh codex --write-codex-agents /path/to/workspace --force-agents
```

For Codex-only advanced usage, `--write-codex-agents /path/to/workspace` is still supported.

## Maintainer Mode

When editing AI Delivery Kit itself, use symlinks so Codex reads the latest local files immediately:

```bash
./install.sh codex --mode link --validate
```

## Uninstall

```bash
./install.sh codex --uninstall
```

## Notes

- Start a new Codex conversation after installing or updating skills, because the available skill list is loaded when a session starts.
- Set `AI_DELIVERY_KIT_CODEX_DEST` when you need to override the installed package location.
- The AI Delivery Kit package is the source of truth for Gates and artifacts; skills only route the task to the right files.
