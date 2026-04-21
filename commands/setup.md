---
description: Check Gemini authentication status and plugin readiness.
argument-hint: "[--check] [--json]"
---

Check the Gemini plugin setup status. Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" setup
```

Return the output verbatim. If authentication is missing, guide the user to run `gemini auth login`.
