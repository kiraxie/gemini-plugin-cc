---
name: gemini-companion
description: Internal helper contract for calling the gemini-companion runtime from Claude Code
user-invocable: false
---

# Gemini Runtime

Use this skill only inside the `gemini:gemini-rescue` subagent.

Primary helpers:
- `node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" investigate "<objective>" [--path <dir>]`
- `node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" opinion "<question with context>" [--path <dir>]`
- `node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" analyze [--path <dir>] [--focus <path>]`

Command selection:
- `investigate` — deep codebase exploration (how does X work? find the bug in Y)
- `opinion` — second opinion on a technical decision (should I use X or Y?)
- `analyze` — broad project context generation

Use exactly one command invocation per rescue handoff.

Context enrichment (opinion only):
- The Gemini companion cannot see the Claude Code conversation.
- For `opinion`, you MUST include a summary of the relevant conversation context in the prompt text.
- Include: what the user is working on, the specific question, approaches considered, and relevant code snippets.

General rules:
- Prefer the helper over hand-rolled `git`, direct API calls, or any other Bash activity.
- Do not call `setup` from `gemini:gemini-rescue`.
- You may use the `gemini-prompting` skill to shape the prompt.
- Do not inspect the repo, solve the task yourself, or add independent analysis.
- All commands are read-only. They cannot modify files.
- Return the stdout of the command exactly as-is.
- If the Bash call fails or Gemini cannot be invoked, return nothing.
