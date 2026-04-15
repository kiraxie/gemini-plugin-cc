/**
 * Core agentic loop — simplified version of Gemini CLI's LocalAgentExecutor.
 *
 * Runs a multi-turn conversation with Gemini, executing tool calls until
 * the model calls `complete_task` or a termination condition is met.
 *
 * Model strategy (matching official Gemini CLI):
 * - Start with config.model (gemini-3-flash-preview)
 * - If rate limited on first turn → restart entirely with config.fallbackModel (gemini-2.5-pro)
 * - Never switch models mid-investigation (keeps report quality consistent)
 */

import type {
  AgentConfig,
  AgentResult,
  Content,
  FunctionCall,
  GeminiClientInterface,
  GenerateContentResponse,
  Part,
} from '../lib/types.js';
import { executeTool } from '../tools/registry.js';
import { COMPLETE_TASK_TOOL_NAME, buildCompleteTaskDeclaration } from './complete-task.js';

const TIMEOUT_WARNING =
  'You have exceeded the time limit. You have one final chance to call the `complete_task` tool ' +
  'with your findings so far. Summarize what you have discovered and call `complete_task` immediately.';

const MAX_TURNS_WARNING =
  'You have reached the maximum number of turns. You have one final chance to call the `complete_task` tool ' +
  'with your findings so far. Summarize what you have discovered and call `complete_task` immediately.';

const NO_TOOL_CALL_WARNING =
  'You must use tools to investigate the codebase. Call one of the available tools, or if you are done, ' +
  'call the `complete_task` tool with your findings.';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function progress(message: string): void {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.error(`[${time}] ${message}`);
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
}

function extractFunctionCalls(parts: Part[]): Array<{ call: FunctionCall; id: string }> {
  const calls: Array<{ call: FunctionCall; id: string }> = [];
  let idx = 0;
  for (const part of parts) {
    if (part.functionCall) {
      calls.push({
        call: part.functionCall,
        id: part.functionCall.id ?? `call-${idx}`,
      });
      idx++;
    }
  }
  return calls;
}

async function collectStreamResponse(
  stream: AsyncGenerator<GenerateContentResponse>,
): Promise<Part[]> {
  const allParts: Part[] = [];
  for await (const chunk of stream) {
    for (const candidate of chunk.candidates ?? []) {
      if (candidate.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.text !== undefined && !part.thought) {
            const lastPart = allParts[allParts.length - 1];
            if (lastPart && lastPart.text !== undefined && !lastPart.thought && !lastPart.functionCall && !lastPart.functionResponse) {
              lastPart.text += part.text;
              continue;
            }
          }
          allParts.push({ ...part });
        }
      }
    }
  }
  return allParts;
}

// ─── Model call ──────────────────────────────────────────────────────────────

function buildGenerationConfig(config: AgentConfig, model: string) {
  // Use thinkingBudget for stable models, thinkingLevel for preview
  if (model === config.model) {
    return config.generationConfig;
  }
  // Fallback model uses thinkingBudget
  return {
    ...config.generationConfig,
    thinkingConfig: {
      includeThoughts: true,
      thinkingBudget: 8192,
    },
  };
}

async function callModel(
  client: GeminiClientInterface,
  config: AgentConfig,
  model: string,
  history: Content[],
  allTools: typeof config.tools,
): Promise<Part[]> {
  const stream = client.generateContentStream({
    model,
    contents: history,
    systemInstruction: { role: 'system', parts: [{ text: config.systemPrompt }] },
    tools: [{ functionDeclarations: allTools }],
    generationConfig: buildGenerationConfig(config, model),
  });
  return await collectStreamResponse(stream);
}

// ─── Core Loop Implementation ────────────────────────────────────────────────

async function executeLoop(
  client: GeminiClientInterface,
  config: AgentConfig,
  model: string,
): Promise<AgentResult> {
  const history: Content[] = [];
  const completeTaskDecl = buildCompleteTaskDeclaration(config.outputSchema);
  const allTools = [...config.tools, completeTaskDecl];

  history.push({ role: 'user', parts: [{ text: config.query }] });

  const startTime = Date.now();
  let turnCount = 0;

  while (turnCount < config.maxTurns) {
    if ((Date.now() - startTime) > config.maxTimeMs) {
      progress('Time limit exceeded. Attempting recovery turn...');
      const recovery = await attemptRecoveryTurn(client, config, model, history, allTools, TIMEOUT_WARNING);
      if (recovery) return recovery;
      return { result: 'Investigation timed out before completion.', terminateReason: 'TIMEOUT' };
    }

    turnCount++;
    progress(`Turn ${turnCount}/${config.maxTurns} [${model}]...`);

    const modelParts = await callModel(client, config, model, history, allTools);
    history.push({ role: 'model', parts: modelParts });

    const functionCalls = extractFunctionCalls(modelParts);

    // Log thoughts
    for (const part of modelParts) {
      if (part.thought && part.text) {
        const preview = part.text.length > 120 ? part.text.slice(0, 120) + '...' : part.text;
        progress(`  [thinking] ${preview}`);
      }
    }

    if (functionCalls.length === 0) {
      progress('  No tool calls received. Nudging...');
      history.push({ role: 'user', parts: [{ text: NO_TOOL_CALL_WARNING }] });
      continue;
    }

    // Process function calls
    const responseParts: Part[] = [];

    for (const { call, id } of functionCalls) {
      if (call.name === COMPLETE_TASK_TOOL_NAME) {
        const outputName = config.outputSchema?.outputName ?? 'result';
        const outputValue = call.args[outputName];

        if (outputValue === undefined || outputValue === null) {
          progress(`  complete_task called without '${outputName}' argument. Asking for retry.`);
          responseParts.push({
            functionResponse: {
              id,
              name: COMPLETE_TASK_TOOL_NAME,
              response: { error: `Missing required argument '${outputName}'.` },
            },
          });
          continue;
        }

        const resultStr = typeof outputValue === 'string'
          ? outputValue
          : JSON.stringify(outputValue, null, 2);

        progress('Investigation complete.');
        return { result: resultStr, terminateReason: 'GOAL' };
      }

      progress(`  [tool] ${call.name}(${summarizeArgs(call.args)})`);
      const toolResult = await executeTool(call.name, call.args, config.cwd);
      responseParts.push({
        functionResponse: {
          id,
          name: call.name,
          response: { result: toolResult },
        },
      });
    }

    history.push({ role: 'user', parts: responseParts });
  }

  // Max turns exceeded
  progress('Max turns exceeded. Attempting recovery turn...');
  const recovery = await attemptRecoveryTurn(client, config, model, history, allTools, MAX_TURNS_WARNING);
  if (recovery) return recovery;

  return { result: 'Investigation reached maximum turns before completion.', terminateReason: 'MAX_TURNS' };
}

// ─── Public Entry Point ──────────────────────────────────────────────────────

/**
 * Run the agent loop. On rate limit during the first turn, automatically
 * restarts the entire investigation with the fallback model.
 */
export async function runAgentLoop(
  client: GeminiClientInterface,
  config: AgentConfig,
): Promise<AgentResult> {
  try {
    return await executeLoop(client, config, config.model);
  } catch (err) {
    if (isRateLimitError(err) && config.model !== config.fallbackModel) {
      progress(`Rate limited on ${config.model}. Restarting with ${config.fallbackModel}...`);
      return await executeLoop(client, config, config.fallbackModel);
    }
    throw err;
  }
}

// ─── Recovery Turn ───────────────────────────────────────────────────────────

async function attemptRecoveryTurn(
  client: GeminiClientInterface,
  config: AgentConfig,
  model: string,
  history: Content[],
  allTools: typeof config.tools,
  warningMessage: string,
): Promise<AgentResult | null> {
  history.push({ role: 'user', parts: [{ text: warningMessage }] });

  try {
    const modelParts = await callModel(client, config, model, history, allTools);
    const functionCalls = extractFunctionCalls(modelParts);

    for (const { call } of functionCalls) {
      if (call.name === COMPLETE_TASK_TOOL_NAME) {
        const outputName = config.outputSchema?.outputName ?? 'result';
        const outputValue = call.args[outputName];
        if (outputValue !== undefined && outputValue !== null) {
          const resultStr = typeof outputValue === 'string'
            ? outputValue
            : JSON.stringify(outputValue, null, 2);
          progress('Recovery turn succeeded.');
          return { result: resultStr, terminateReason: 'GOAL' };
        }
      }
    }
  } catch (err) {
    progress(`Recovery turn failed: ${(err as Error).message}`);
  }

  return null;
}

// ─── Utils ───────────────────────────────────────────────────────────────────

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  const parts = entries.slice(0, 2).map(([k, v]) => {
    const str = String(v);
    return `${k}=${str.length > 40 ? str.slice(0, 40) + '...' : str}`;
  });
  if (entries.length > 2) parts.push('...');
  return parts.join(', ');
}
