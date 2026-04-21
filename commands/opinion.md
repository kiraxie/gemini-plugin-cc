---
description: Get a second opinion from Gemini on a technical question. Include relevant context from the current conversation.
argument-hint: "\"<question with context>\" [--path <dir>] [--background] [--standard]"
---

Get a technical second opinion from Gemini. Before invoking, summarize the relevant context from the current conversation (what you're working on, what approaches you've considered, relevant code snippets) and include it in the arguments.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" opinion $ARGUMENTS
```

Supports `--path <dir>` to scope file exploration to a specific directory.

Return the output verbatim. The opinion includes:
- **Opinion**: Direct recommendation
- **Reasoning**: Trade-offs and analysis
- **Alternatives**: Other approaches considered
- **References**: Files examined
