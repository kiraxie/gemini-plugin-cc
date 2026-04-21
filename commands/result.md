---
description: Retrieve the output of a completed background Gemini job. Defaults to the latest finished job.
argument-hint: "[job-id] [--json]"
---

Get a background job's result. Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" result $ARGUMENTS
```

Return the output verbatim.
