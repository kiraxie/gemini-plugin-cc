/**
 * analyze command — produces a project context document using Gemini.
 *
 * Unlike investigate (focused, question-driven), analyze explores the
 * entire codebase broadly to build a baseline understanding suitable
 * for injection into Claude's context.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createAuth } from '../lib/gemini-auth.js';
import { GeminiClient } from '../lib/client.js';
import { createAnalyzerConfig } from '../agents/codebase-analyzer.js';
import { runAgentLoop } from '../agents/agent-loop.js';
import { renderAnalysisReport } from '../lib/render.js';

export interface AnalyzeOptions {
  path?: string;
  focus?: string;
  writePath?: string;
  forceStandard?: boolean;
}

export async function runAnalyze(options: AnalyzeOptions = {}): Promise<void> {
  const cwd = resolve(options.path ?? process.cwd());
  const { focus, writePath, forceStandard = false } = options;

  // Authenticate
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
  progress(`Project: ${cwd}`);
  if (focus) progress(`Focus: ${focus}`);
  console.error('');

  const config = createAnalyzerConfig(cwd, useCodeAssist, focus);

  const result = await runAgentLoop(client, config);

  // Render structured JSON → Markdown
  const rendered = renderAnalysisReport(result.result);

  // Output to stdout
  console.log(rendered);

  // Write to file if requested
  if (writePath) {
    const outPath = resolve(cwd, writePath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rendered, 'utf-8');
    progress(`Context document saved to: ${outPath}`);
  }

  if (result.terminateReason !== 'GOAL') {
    console.error(`\n[gemini] Analysis ended with reason: ${result.terminateReason}`);
  }
}

function progress(message: string): void {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.error(`[${time}] ${message}`);
}
