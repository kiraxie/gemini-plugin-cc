/**
 * analyze command — produces a project context document using a DFS pipeline.
 *
 * Instead of an agent loop (many turns), this uses a structured pipeline:
 * Phase 1: Local DFS scan (zero API calls)
 * Phase 2: Per-directory summarization (1 API call per directory)
 * Phase 3: Synthesis into final report (1 API call)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createAuth } from '../lib/gemini-auth.js';
import { GeminiClient } from '../lib/client.js';
import { runAnalyzePipeline } from '../agents/analyze-pipeline.js';
import { renderAnalysisReport } from '../lib/render.js';

/** Code Assist uses flash for subagents */
const CODE_ASSIST_MODEL = 'gemini-3-flash-preview';
/** Stable fallback */
const STANDARD_FALLBACK_MODEL = 'gemini-2.5-pro';

export interface AnalyzeOptions {
  path?: string;
  focus?: string;
  writePath?: string;
  forceStandard?: boolean;
}

export async function runAnalyze(options: AnalyzeOptions = {}): Promise<void> {
  const cwd = resolve(options.path ?? process.cwd());
  const { focus, writePath, forceStandard = false } = options;

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
  const primaryModel = useCodeAssist ? CODE_ASSIST_MODEL : STANDARD_FALLBACK_MODEL;

  progress(`Auth type: ${auth.type}`);
  progress(`API: ${useCodeAssist ? 'Code Assist' : 'Standard'}`);
  progress(`Primary model: ${primaryModel}`);
  progress(`Project: ${cwd}`);
  if (focus) progress(`Focus: ${focus}`);
  console.error('');

  const rawReport = await runAnalyzePipeline(client, cwd, primaryModel, focus);

  const rendered = renderAnalysisReport(rawReport);
  console.log(rendered);

  if (writePath) {
    const outPath = resolve(cwd, writePath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rendered, 'utf-8');
    progress(`Context document saved to: ${outPath}`);
  }
}

function progress(message: string): void {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.error(`[${time}] ${message}`);
}
