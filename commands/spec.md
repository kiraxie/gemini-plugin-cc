---
description: Reverse-engineer a non-engineer-facing functional spec from the codebase to docs/SPEC.md.
argument-hint: "[--full] [--output <path>] [--from <hash>] [--dry-run] [--on-conflict abort|keep|overwrite] [--standard]"
---

Reverse-engineer a functional specification from the codebase using Gemini.
The output is intended for PMs / business stakeholders to verify against
real product requirements — discrepancies often reveal genuine bugs.

Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/gemini-companion.cjs" spec $ARGUMENTS
```

Default output path: `docs/SPEC.md` (relative to project root).

Supports:
- `--full` force a full rebuild (ignore previous version anchor)
- `--output <path>` override the output file path
- `--from <hash>` use a specific commit as the diff anchor (advanced)
- `--dry-run` show which sections would be regenerated without calling Gemini
- `--on-conflict <abort|keep|overwrite>` how to handle manual edits detected
  in the existing SPEC.md (default: `abort` with a clear error)
- `--standard` force the standard API (gemini-2.5)

Behaviour:
- **First run**: scans the entire project, identifies project type and all
  user-facing features, writes a complete SPEC.md sorted by importance.
- **Subsequent runs**: uses each section's stored commit hash to diff against
  HEAD, regenerates only sections whose source files changed, and adds new
  sections for changed files not yet covered.
- **Manual edits**: if the user has hand-edited the SPEC.md, `/gemini:spec`
  refuses to clobber by default. Re-run with `--on-conflict keep` to skip
  those sections, or `--on-conflict overwrite` to regenerate them.

Each section in the output carries an HTML comment with `sources`,
`last-updated` (commit hash), and `content-hash` — these power the
incremental updates. Do not edit those comments by hand.

When the command exits with code 2 it indicates a manual-edit conflict; ask
the user how to proceed and re-run with the appropriate `--on-conflict` flag.
