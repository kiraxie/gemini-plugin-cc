---
description: Produce a Gemini-powered project context document covering architecture, modules, conventions, and entry points.
---

Run a project analysis using Gemini. Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" analyze $ARGUMENTS
```

Supports:
- `--focus <area>` to emphasize a specific part of the codebase
- `--write <path>` to save the context document to a file
- `--standard` to force the standard API (gemini-2.5)

The output is a Markdown context document with:
- **Overview**: Project purpose and design philosophy
- **Tech Stack**: Language, framework, key dependencies
- **Module Map**: Each module's role, key files, and exports
- **Conventions**: Detected patterns and where they are used
- **Entry Points**: Where execution begins
- **Architecture Notes**: Trade-offs and gotchas
