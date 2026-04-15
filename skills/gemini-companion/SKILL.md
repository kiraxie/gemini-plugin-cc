---
name: gemini-companion
description: Internal helper contract for calling the gemini-companion runtime from Claude Code
user-invocable: false
---

# Gemini Runtime

Use this skill only inside the `gemini:gemini-rescue` subagent.

Primary helpers:
- `node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" investigate "<objective>"`
- `node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" analyze [--path <dir>] [--focus <path>]`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `investigate` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct API calls, or any other Bash activity.
- Do not call `setup` from `gemini:gemini-rescue`.
- Use `investigate` for every rescue request, including bug analysis, architecture mapping, dependency tracing, and feature exploration.
- You may use the `gemini-prompting` skill to rewrite the user's request into a tighter investigation objective before the single `investigate` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.

Command selection:
- Use exactly one `investigate` invocation per rescue handoff.
- Preserve the user's task text as-is apart from prompt shaping.

Safety rules:
- The investigator is read-only. It cannot modify files.
- Return the stdout of the command exactly as-is.
- If the Bash call fails or Gemini cannot be invoked, return nothing.
