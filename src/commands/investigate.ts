/**
 * investigate command — runs the codebase investigator agent loop.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createAuth } from '../lib/gemini-auth.js';
import { GeminiClient } from '../lib/client.js';
import { createInvestigatorConfig } from '../agents/codebase-investigator.js';
import { runAgentLoop } from '../agents/agent-loop.js';
import { renderInvestigationReport } from '../lib/render.js';

export interface InvestigateOptions {
  path?: string;
  forceStandard?: boolean;
  writePath?: string;
}

export async function runInvestigate(objective: string, cwd: string, options: InvestigateOptions = {}): Promise<void> {
  const { path: scopePath, forceStandard = false, writePath } = options;
  const effectiveCwd = scopePath ? resolve(cwd, scopePath) : cwd;
  if (!objective.trim()) {
    console.error('Error: Please provide an investigation objective.');
    process.exit(1);
  }

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
  if (scopePath) progress(`Scope: ${effectiveCwd}`);
  progress(`Objective: ${objective}`);
  console.error('');

  const config = createInvestigatorConfig(objective, effectiveCwd, useCodeAssist);

  const result = await runAgentLoop(client, config);

  // Render structured JSON → Markdown
  const rendered = renderInvestigationReport(result.result);

  // Output the report to stdout (consumed by Claude Code agent)
  console.log(rendered);

  // Write report to file if requested
  if (writePath) {
    const outPath = resolve(cwd, writePath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rendered, 'utf-8');
    progress(`Report saved to: ${outPath}`);
  }

  if (result.terminateReason !== 'GOAL') {
    console.error(`\n[gemini] Investigation ended with reason: ${result.terminateReason}`);
  }
}

function progress(message: string): void {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.error(`[${time}] ${message}`);
}
