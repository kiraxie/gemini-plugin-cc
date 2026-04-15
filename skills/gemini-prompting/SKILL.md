---
name: gemini-prompting
description: Internal guidance for composing Gemini investigation prompts for codebase analysis tasks
user-invocable: false
---

# Gemini Prompt Crafting

When composing an investigation objective for Gemini's codebase investigator:

## Structure
- Lead with a clear, specific objective statement
- Include the user's original question or goal verbatim
- Add any context about what area of the codebase is relevant
- Mention specific symptoms, error messages, or behaviors if debugging

## Good objectives
- "Investigate the authentication middleware to understand how JWT tokens are validated and refreshed, and identify all callers of the refresh function."
- "Find the root cause of the race condition in the order processing pipeline. The symptom is duplicate orders appearing when two requests arrive within 100ms."
- "Map the dependency graph of the plugin system: how plugins are discovered, loaded, initialized, and how they communicate with the host."

## Bad objectives
- "Look at the code" (too vague)
- "Fix the bug" (investigator is read-only, it finds and reports, not fixes)
- "Rewrite the auth system using OAuth" (investigator explores, not implements)

## Tips
- The investigator has tools: list_directory, read_file, glob, grep_search, web_fetch
- It works best with specific questions that require tracing through multiple files
- It returns a structured report with SummaryOfFindings, ExplorationTrace, and RelevantLocations
