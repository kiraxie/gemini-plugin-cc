/**
 * Opinion Advisor agent definition.
 *
 * Provides a second opinion on technical questions with optional
 * codebase exploration. Designed to receive context-enriched prompts
 * from the Claude Code subagent.
 */

import type { AgentConfig, JsonSchema, VertexGenerationConfig } from '../lib/types.js';
import { getToolDeclarations } from '../tools/registry.js';

// ─── Model Configuration ─────────────────────────────────────────────────────

const CODE_ASSIST_MODEL = 'gemini-3-flash-preview';
const STANDARD_FALLBACK_MODEL = 'gemini-2.5-pro';
const DEFAULT_THINKING_BUDGET = 8192;

function getGenerationConfig(useCodeAssist: boolean): VertexGenerationConfig {
  return {
    temperature: 0.3,
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
    Opinion: {
      type: 'string',
      description: 'Your technical opinion, analysis, and recommendation.',
    },
    Reasoning: {
      type: 'string',
      description: 'The reasoning process behind your opinion, including trade-offs considered.',
    },
    Alternatives: {
      type: 'array',
      description: 'Alternative approaches considered and why they were or were not recommended.',
      items: {
        type: 'object',
        properties: {
          approach: { type: 'string' },
          prosAndCons: { type: 'string' },
        },
        required: ['approach', 'prosAndCons'],
      },
    },
    References: {
      type: 'array',
      description: 'Relevant file paths examined to form this opinion.',
      items: { type: 'string' },
    },
  },
  required: ['Opinion', 'Reasoning'],
};

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are **Technical Advisor**, a senior software engineer providing second opinions on technical decisions.

You receive a question along with context from an ongoing development session. Your role is to provide an independent, well-reasoned perspective.

## Guidelines
1. **Be direct**: Lead with your recommendation, then explain why.
2. **Consider trade-offs**: Every technical choice has pros and cons. Acknowledge them.
3. **Be practical**: Focus on what works in production, not just theoretical elegance.
4. **Challenge assumptions**: If the framing of the question contains a flawed premise, say so.
5. **Use the codebase**: If the question relates to existing code, use your tools to read the relevant files before forming an opinion. Do not guess about code you haven't seen.
6. **Be concise**: Respect the developer's time. Don't pad your answer.

## When to use tools
- If the question references specific files, functions, or patterns in the codebase → read them first.
- If you need to understand the project structure to give a meaningful answer → use list_directory or glob.
- If the question is purely conceptual (e.g., "mutex vs channel in Go") → you may answer directly without tools.

## Termination
When you have formed your opinion, call \`complete_task\` with your findings. Do not over-investigate — this is a focused consultation, not a deep audit.
`;

// ─── Query Template ──────────────────────────────────────────────────────────

function buildQuery(question: string): string {
  return question;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function createOpinionConfig(
  question: string,
  cwd: string,
  useCodeAssist: boolean,
): AgentConfig {
  return {
    model: useCodeAssist ? CODE_ASSIST_MODEL : STANDARD_FALLBACK_MODEL,
    fallbackModel: STANDARD_FALLBACK_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    query: buildQuery(question),
    tools: getToolDeclarations(),
    generationConfig: getGenerationConfig(useCodeAssist),
    maxTurns: 6,
    maxTimeMs: 2 * 60 * 1000, // 2 minutes (focused consultation)
    outputSchema: {
      outputName: 'report',
      description: 'The technical opinion as a JSON object.',
      schema: outputSchema,
    },
    cwd,
  };
}
