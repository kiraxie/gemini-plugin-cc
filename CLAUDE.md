# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
npm run build      # esbuild → dist/gemini-companion.cjs (must rebuild after any src/ change)
npm run typecheck   # tsc --noEmit (type checking only, no output)
```

Test locally in Claude Code:
```bash
claude --plugin-dir .
```
Then `/reload-plugins` after rebuilding.

## Architecture

This is a Claude Code plugin that delegates codebase tasks to Google Gemini. TypeScript source in `src/` is bundled by esbuild into a single self-contained CJS file (`dist/gemini-companion.cjs`) which is committed to the repo.

### Dual API Client (`src/lib/`)

- **Code Assist API** (`code-assist-client.ts`): Primary path via `cloudcode-pa.googleapis.com`. Uses OAuth from `~/.gemini/oauth_creds.json`. Supports gemini-3 preview models.
- **Standard API** (`standard-client.ts`): Fallback for API key users only. OAuth users stay on Code Assist (standard API rejects OAuth scopes).
- **Unified Client** (`client.ts`): Wraps both. OAuth users never degrade to standard API.

Each `CodeAssistClient` instance generates a stable `session_id` (UUID) per CLI invocation and sends a `User-Agent` header — both required to avoid aggressive rate limiting.

### Three Execution Modes

1. **Agent Loop** (`agents/agent-loop.ts`): Multi-turn function calling. Used by `investigate` and `opinion`. On rate limit, restarts the entire run with fallback model (no mid-run model switching).
2. **DFS Pipeline** (`agents/analyze-pipeline.ts`): Used by `analyze`. Phase 1: local filesystem scan. Phase 2: per-directory summarization (flash for simple dirs, primary for complex). Phase 3: synthesis. Far fewer API calls than the agent loop.
3. **Background Worker** (`commands/background.ts`): Spawns a detached child process. Job state persisted in `$CLAUDE_PLUGIN_DATA/state/`. Status/result retrieved via separate commands.

### Model Tiering

- Primary: `gemini-3-flash-preview` (Code Assist API)
- Fallback: `gemini-2.5-pro` (on rate limit)
- Cheap: `gemini-2.5-flash` (for simple directory summarization in analyze pipeline)

### Plugin Structure

Plugin definitions (agents, skills, commands, hooks) live at the repo root. Claude Code discovers them from `.claude-plugin/plugin.json`. The `gemini-rescue` agent is a thin Claude subagent that forwards requests to `node dist/gemini-companion.cjs`.

### Request Format

Code Assist API uses a nested Vertex-style request format (`CAGenerateContentRequest` wrapping `VertexGenerateContentRequest`). The converter is in `code-assist-client.ts`. Key: model name is sent as-is (no `models/` prefix), and `session_id` goes inside the inner request body.

## Important Patterns

- All renderers (`src/lib/render.ts`) strip markdown code fences before JSON.parse — Gemini often wraps JSON output in ``` fences.
- `dist/gemini-companion.cjs` is CJS format (not ESM) because `google-auth-library` uses internal `require()` calls incompatible with ESM bundles. The `package.json` has `"type": "module"` so the output must be `.cjs`.
- Tools (`src/tools/`) each export a `declaration` (FunctionDeclaration for Gemini) and an `execute` function. The registry maps tool names to implementations.
