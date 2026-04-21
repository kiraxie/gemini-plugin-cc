/**
 * spec command — reverse-engineer a non-engineer-facing functional
 * specification (`docs/SPEC.md`) from the codebase.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createAuth } from '../lib/gemini-auth.js';
import { GeminiClient } from '../lib/client.js';
import { runSpecPipeline, ConflictError, type ConflictStrategy } from '../agents/spec-pipeline.js';

const CODE_ASSIST_MODEL = 'gemini-3-flash-preview';
const STANDARD_FALLBACK_MODEL = 'gemini-2.5-pro';
const DEFAULT_OUTPUT = 'docs/SPEC.md';

export interface SpecOptions {
  cwd?: string;
  output?: string;
  full?: boolean;
  fromHash?: string;
  dryRun?: boolean;
  onConflict?: ConflictStrategy;
  forceStandard?: boolean;
}

export async function runSpec(options: SpecOptions = {}): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const outputPath = resolve(cwd, options.output ?? DEFAULT_OUTPUT);
  const forceStandard = options.forceStandard ?? false;

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
  progress(`Output: ${outputPath}`);
  console.error('');

  let result;
  try {
    result = await runSpecPipeline(client, {
      cwd,
      outputPath,
      primaryModel,
      full: options.full,
      fromHash: options.fromHash,
      dryRun: options.dryRun,
      onConflict: options.onConflict ?? 'abort',
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      console.error('');
      console.error('⚠️  Manual edits detected in existing SPEC.md.');
      console.error(`   Sections: ${err.editedSections.join(', ')}`);
      console.error('');
      console.error('Choose how to proceed and re-run:');
      console.error('  --on-conflict keep       保留人工修改的章節（不重新生成）');
      console.error('  --on-conflict overwrite  覆寫人工修改（強制重新生成）');
      process.exit(2);
    }
    throw err;
  }

  console.error('');
  progress(`Mode: ${result.mode}`);
  progress(`HEAD: ${result.headHash}`);
  if (result.changedSections.length > 0) {
    progress(`Updated sections (${result.changedSections.length}): ${result.changedSections.join(', ')}`);
  }
  if (result.newSections.length > 0) {
    progress(`New sections (${result.newSections.length}): ${result.newSections.join(', ')}`);
  }
  if (result.skippedSections.length > 0) {
    progress(`Unchanged (${result.skippedSections.length}): ${truncList(result.skippedSections)}`);
  }
  if (result.manualEditedSections.length > 0) {
    progress(`Manual edits respected: ${result.manualEditedSections.join(', ')}`);
  }

  if (result.dryRun) {
    progress('Dry run — no file written.');
    return;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, result.document, 'utf-8');
  progress(`SPEC written to: ${outputPath}`);

  // Also surface the document content via stdout so the slash command can
  // display it inline if the user wants, mirroring `analyze`'s behaviour.
  console.log(result.document);
}

function truncList(items: string[]): string {
  if (items.length <= 5) return items.join(', ');
  return `${items.slice(0, 5).join(', ')}, ...(+${items.length - 5} more)`;
}

function progress(message: string): void {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.error(`[${time}] ${message}`);
}
