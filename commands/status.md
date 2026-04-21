---
description: Show status of background Gemini jobs. Optionally specify a job ID for details.
argument-hint: "[job-id] [--all] [--json]"
---

Check Gemini background job status. Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" status $ARGUMENTS
```

Use `--all` to show jobs from all sessions. Return the output verbatim.
