---
description: Quick project structure scan using Gemini. Detects language, entry points, and top-level layout.
---

Run a quick project analysis. Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" analyze $ARGUMENTS
```

Return the output verbatim. This is a lightweight scan (no AI calls) that detects project metadata.
