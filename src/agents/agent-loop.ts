/**
 * Core agentic loop — simplified version of Gemini CLI's LocalAgentExecutor.
 *
 * Runs a multi-turn conversation with Gemini, executing tool calls until
 * the model calls `complete_task` or a termination condition is met.
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

const GRACE_PERIOD_MS = 60_000;

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
          // Merge text parts (streaming sends incremental text)
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

// ─── Main Loop ───────────────────────────────────────────────────────────────

export async function runAgentLoop(
  client: GeminiClientInterface,
  config: AgentConfig,
): Promise<AgentResult> {
  const history: Content[] = [];
  const completeTaskDecl = buildCompleteTaskDeclaration(config.outputSchema);
  const allTools = [...config.tools, completeTaskDecl];

  // Initial user message
  history.push({ role: 'user', parts: [{ text: config.query }] });

  const startTime = Date.now();
  let turnCount = 0;
  let rateLimitWaitMs = 0; // Exclude rate limit waits from timeout

  while (turnCount < config.maxTurns) {
    // Check timeout (excluding time spent waiting for rate limits)
    const effectiveElapsed = (Date.now() - startTime) - rateLimitWaitMs;
    if (effectiveElapsed > config.maxTimeMs) {
      progress('Time limit exceeded. Attempting recovery turn...');
      const recovery = await attemptRecoveryTurn(client, config, history, allTools, TIMEOUT_WARNING);
      if (recovery) return recovery;
      return { result: 'Investigation timed out before completion.', terminateReason: 'TIMEOUT' };
    }

    turnCount++;
    progress(`Turn ${turnCount}/${config.maxTurns}...`);

    // Call the model with retry on rate limit (429)
    let modelParts: Part[];
    try {
      const retryResult = await callModelWithRetry(client, config, history, allTools);
      modelParts = retryResult.parts;
      rateLimitWaitMs += retryResult.rateLimitWaitMs;
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
        progress('Rate limit exceeded after retries. Ending investigation early.');
        return { result: 'Investigation paused due to API rate limiting. Partial results may be available in the conversation history.', terminateReason: 'ERROR' };
      }
      throw err;
    }
    history.push({ role: 'model', parts: modelParts });

    // Extract function calls
    const functionCalls = extractFunctionCalls(modelParts);

    // Log thoughts
    for (const part of modelParts) {
      if (part.thought && part.text) {
        const preview = part.text.length > 120 ? part.text.slice(0, 120) + '...' : part.text;
        progress(`  [thinking] ${preview}`);
      }
    }

    if (functionCalls.length === 0) {
      // No tool calls — give the model one more chance
      progress('  No tool calls received. Nudging...');
      history.push({ role: 'user', parts: [{ text: NO_TOOL_CALL_WARNING }] });
      continue;
    }

    // Process each function call
    const responseParts: Part[] = [];

    for (const { call, id } of functionCalls) {
      // Check for complete_task
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

      // Execute regular tool
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

  // Max turns exceeded — recovery turn
  progress('Max turns exceeded. Attempting recovery turn...');
  const recovery = await attemptRecoveryTurn(client, config, history, allTools, MAX_TURNS_WARNING);
  if (recovery) return recovery;

  return { result: 'Investigation reached maximum turns before completion.', terminateReason: 'MAX_TURNS' };
}

async function attemptRecoveryTurn(
  client: GeminiClientInterface,
  config: AgentConfig,
  history: Content[],
  allTools: typeof config.tools,
  warningMessage: string,
): Promise<AgentResult | null> {
  history.push({ role: 'user', parts: [{ text: warningMessage }] });

  try {
    const retryResult = await callModelWithRetry(client, config, history, allTools);
    const modelParts = retryResult.parts;
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

interface RetryResult {
  parts: Part[];
  rateLimitWaitMs: number;
}

async function callModelWithRetry(
  client: GeminiClientInterface,
  config: AgentConfig,
  history: Content[],
  allTools: typeof config.tools,
  maxRetries = 3,
): Promise<RetryResult> {
  let totalWaitMs = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const stream = client.generateContentStream({
        model: config.model,
        contents: history,
        systemInstruction: { role: 'system', parts: [{ text: config.systemPrompt }] },
        tools: [{ functionDeclarations: allTools }],
        generationConfig: config.generationConfig,
      });
      return { parts: await collectStreamResponse(stream), rateLimitWaitMs: totalWaitMs };
    } catch (err) {
      const errMsg = (err as Error).message;
      const isRateLimit = errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED');

      if (isRateLimit && attempt < maxRetries) {
        // Extract wait time from error message if available
        const waitMatch = /reset after (\d+)s/.exec(errMsg);
        const waitSec = waitMatch ? parseInt(waitMatch[1], 10) + 2 : 30 * (attempt + 1);
        progress(`Rate limited. Waiting ${waitSec}s before retry (${attempt + 1}/${maxRetries})...`);
        const waitMs = waitSec * 1000;
        totalWaitMs += waitMs;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

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
