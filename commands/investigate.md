---
description: Run a deep Gemini-powered codebase investigation. Provide an objective describing what to analyze.
argument-hint: "\"<objective>\" [--path <dir>] [--write <path>] [--background] [--standard]"
---

Run a codebase investigation using Gemini. Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" investigate $ARGUMENTS
```

Supports:
- `--path <dir>` to scope the investigation to a specific directory
- `--write <path>` to save the report to a file (path relative to project root)

Return the output verbatim. The investigation report contains:
- **SummaryOfFindings**: Conclusions and actionable insights
- **ExplorationTrace**: Step-by-step actions taken
- **RelevantLocations**: Key files, their purposes, and important symbols
