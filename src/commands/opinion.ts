/**
 * opinion command — get a second opinion from Gemini on a technical question.
 *
 * Designed to receive context-enriched prompts from the gemini-rescue
 * Claude Code subagent, which summarizes the current conversation context
 * before forwarding to Gemini.
 */

import { resolve } from 'node:path';
import { createAuth } from '../lib/gemini-auth.js';
import { GeminiClient } from '../lib/client.js';
import { createOpinionConfig } from '../agents/opinion-advisor.js';
import { runAgentLoop } from '../agents/agent-loop.js';
import { renderOpinionReport } from '../lib/render.js';

export interface OpinionOptions {
  path?: string;
  forceStandard?: boolean;
}

export async function runOpinion(question: string, cwd: string, options: OpinionOptions = {}): Promise<void> {
  const { path: scopePath, forceStandard = false } = options;
  const effectiveCwd = scopePath ? resolve(cwd, scopePath) : cwd;

  if (!question.trim()) {
    console.error('Error: Please provide a question for the opinion.');
    process.exit(1);
  }

  let auth;
  try {
    auth = await createAuth();
  } catch (err) {
    console.error(`Authentication failed: ${(err as Error).message}`);
    console.error('Run `gemini auth login` or set GEMINI_API_KEY to continue.');
    process.exit(1);
  }

  const client = new GeminiClient(auth, forceStandard);
  const useCodeAssist = !forceStandard && !!(auth.oauthClient && !client.isDegraded);

  progress(`Auth type: ${auth.type}`);
  progress(`API: ${useCodeAssist ? 'Code Assist (gemini-3)' : 'Standard (gemini-2.5)'}`);
  console.error('');

  const config = createOpinionConfig(question, effectiveCwd, useCodeAssist);
  const result = await runAgentLoop(client, config);

  const rendered = renderOpinionReport(result.result);
  console.log(rendered);

  if (result.terminateReason !== 'GOAL') {
    console.error(`\n[gemini] Opinion ended with reason: ${result.terminateReason}`);
  }
}

function progress(message: string): void {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.error(`[${time}] ${message}`);
}
