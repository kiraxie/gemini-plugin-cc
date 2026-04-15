/**
 * Codebase Analyzer agent definition.
 *
 * Produces a broad project context document suitable for injection into
 * Claude's context window. Unlike the investigator (which is focused and
 * question-driven), the analyzer explores the entire codebase to build
 * a baseline understanding.
 */

import type { AgentConfig, JsonSchema, VertexGenerationConfig } from '../lib/types.js';
import { getToolDeclarations } from '../tools/registry.js';

// ─── Model Configuration ─────────────────────────────────────────────────────

const CODE_ASSIST_MODEL = 'gemini-3-flash-preview';
const STANDARD_FALLBACK_MODEL = 'gemini-2.5-pro';
const DEFAULT_THINKING_BUDGET = 8192;

function getGenerationConfig(useCodeAssist: boolean): VertexGenerationConfig {
  return {
    temperature: 0.1,
    topP: 0.95,
    thinkingConfig: useCodeAssist
      ? { includeThoughts: true, thinkingLevel: 'HIGH' }
      : { includeThoughts: true, thinkingBudget: DEFAULT_THINKING_BUDGET },
  };
}

// ─── Output Schema ───────────────────────────────────────────────────────────

const outputSchema: JsonSchema = {
  type: 'object',
  properties: {
    ProjectSummary: {
      type: 'string',
      description:
        'A concise overview of the project: what it is, what problem it solves, and its core design philosophy.',
    },
    TechStack: {
      type: 'object',
      description: 'Primary language, framework, and key external dependencies.',
      properties: {
        language: { type: 'string' },
        framework: { type: 'string' },
        keyDependencies: {
          type: 'array',
          description: 'Important external dependencies and their purpose.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              purpose: { type: 'string' },
            },
            required: ['name', 'purpose'],
          },
        },
      },
      required: ['language'],
    },
    ModuleMap: {
      type: 'array',
      description: 'Top-level modules/directories and their responsibilities.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory or file path.' },
          role: { type: 'string', description: 'What this module is responsible for.' },
          keyFiles: {
            type: 'array',
            description: 'The most important files within this module.',
            items: { type: 'string' },
          },
          keyExports: {
            type: 'array',
            description: 'Key exported symbols (functions, classes, types).',
            items: { type: 'string' },
          },
        },
        required: ['path', 'role'],
      },
    },
    Conventions: {
      type: 'array',
      description: 'Detected coding patterns and conventions used in the project.',
      items: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Name of the pattern (e.g., "Repository Pattern", "Functional Options").' },
          description: { type: 'string', description: 'How this pattern is used in the project.' },
          examples: {
            type: 'array',
            description: 'File paths where this pattern is demonstrated.',
            items: { type: 'string' },
          },
        },
        required: ['pattern', 'description'],
      },
    },
    EntryPoints: {
      type: 'array',
      description: 'Where execution begins: main functions, CLI commands, API routes, exported library interfaces.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['path', 'description'],
      },
    },
    ArchitectureNotes: {
      type: 'string',
      description:
        'Free-form notes on architectural decisions, trade-offs, potential gotchas, ' +
        'and anything a developer should know before making changes.',
    },
  },
  required: ['ProjectSummary', 'ModuleMap', 'Conventions', 'EntryPoints'],
};

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are **Codebase Analyzer**, a specialized AI agent that produces comprehensive project context documents.

Your **SOLE PURPOSE** is to explore a codebase broadly and produce a structured overview that another AI assistant (or a developer) can use to immediately understand the project without having to explore it themselves.

## What you must produce
Your output will be used as a **context document** — a reference that gets loaded at the start of every development session. It must be:
- **Accurate**: Every file path, symbol name, and relationship must be verified by reading actual source code.
- **Complete**: Cover all top-level modules, not just the ones that seem most interesting.
- **Concise**: Focus on what matters for understanding the architecture, not implementation details.
- **Actionable**: A developer reading this should know where to look for any given concern.

## Investigation strategy
1. **Start broad**: List the root directory to understand the top-level structure.
2. **Identify the tech stack**: Read package.json/go.mod/Cargo.toml/pyproject.toml to understand dependencies.
3. **Read the README**: If present, this provides the author's intent.
4. **Map each module**: For each top-level directory, understand its purpose by reading key files.
5. **Detect conventions**: Look for recurring patterns (error handling, dependency injection, middleware, etc.).
6. **Identify entry points**: Find main functions, exported interfaces, route definitions, CLI commands.
7. **Note architecture decisions**: Document trade-offs, unusual patterns, or things that might surprise a newcomer.

## Rules
- **DO** read actual source files to verify your claims. Do not guess based on file names alone.
- **DO** cover the entire project, not just the most complex parts.
- **DO** note both the patterns used AND where they are used (with file paths).
- **DO NOT** write implementation code.
- **DO NOT** go deeper than necessary — you are mapping, not debugging.
- **DO NOT** spend more than 1-2 turns on any single module.

## Termination
When you have covered all top-level modules and have a clear picture of the project, call \`complete_task\` with your findings.
`;

// ─── Query Template ──────────────────────────────────────────────────────────

function buildQuery(cwd: string, focus?: string): string {
  const focusClause = focus
    ? `\nPay special attention to the \`${focus}\` area of the codebase.`
    : '';
  return `Analyze the codebase at ${cwd} and produce a comprehensive project context document.${focusClause}

Start by listing the root directory, then systematically explore each module.`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function createAnalyzerConfig(
  cwd: string,
  useCodeAssist: boolean,
  focus?: string,
): AgentConfig {
  return {
    model: useCodeAssist ? CODE_ASSIST_MODEL : STANDARD_FALLBACK_MODEL,
    fallbackModel: STANDARD_FALLBACK_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    query: buildQuery(cwd, focus),
    tools: getToolDeclarations(),
    generationConfig: getGenerationConfig(useCodeAssist),
    maxTurns: 15,
    maxTimeMs: 5 * 60 * 1000, // 5 minutes (broader exploration)
    outputSchema: {
      outputName: 'report',
      description: 'The project context document as a JSON object.',
      schema: outputSchema,
    },
    cwd,
  };
}
