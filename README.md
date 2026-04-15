# gemini-plugin-cc

A [Claude Code](https://claude.ai/code) plugin that delegates codebase investigation and analysis tasks to Google Gemini.

## Prerequisites

- [Claude Code](https://claude.ai/code) installed
- Run `gemini auth login` ([Gemini CLI](https://github.com/google-gemini/gemini-cli)) or set `GEMINI_API_KEY`

## Installation

```bash
claude plugin install gemini@https://github.com/kiraxie/gemini-plugin-cc
```

## Commands

| Command | Description |
|---------|-------------|
| `/gemini:investigate "<objective>"` | Deep codebase exploration with function calling |
| `/gemini:analyze` | Generate a project context document (DFS pipeline) |
| `/gemini:opinion "<question>"` | Get a second opinion on a technical decision |
| `/gemini:status [job-id]` | Check background job progress |
| `/gemini:result [job-id]` | Retrieve background job output |
| `/gemini:setup` | Check authentication status |

### Options

- `--path <dir>` — Scope to a specific directory
- `--write <path>` — Save output to a file
- `--background` — Run in background

## License

Apache-2.0
