#!/usr/bin/env node

/**
 * gemini-companion — CLI entry point for the Gemini Claude Code plugin.
 */

import process from 'node:process';
import { runSetup } from './commands/setup.js';
import { runInvestigate } from './commands/investigate.js';
import { runAnalyze } from './commands/analyze.js';
import { runSpec } from './commands/spec.js';
import { runOpinion } from './commands/opinion.js';
import { runStatus } from './commands/status.js';
import { runResult } from './commands/result.js';
import { enqueueBackground, runWorker } from './commands/background.js';

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  gemini-companion setup [--check] [--json]',
      '  gemini-companion investigate "<objective>" [--path <dir>] [--write <path>] [--background] [--standard]',
      '  gemini-companion analyze [--path <dir>] [--focus <area>] [--write <path>] [--background] [--standard]',
      '  gemini-companion spec [--path <dir>] [--output <path>] [--full] [--from <hash>] [--dry-run] [--on-conflict abort|keep|overwrite] [--standard]',
      '  gemini-companion opinion "<question with context>" [--path <dir>] [--background] [--standard]',
      '  gemini-companion status [job-id] [--all] [--json]',
      '  gemini-companion result [job-id] [--json]',
      '',
      'Commands:',
      '  setup        Check authentication status and plugin readiness',
      '  investigate   Run a deep Gemini-powered codebase investigation',
      '  analyze      Produce a project context document using Gemini',
      '  spec         Reverse-engineer a non-engineer functional spec to docs/SPEC.md',
      '  opinion      Get a second opinion from Gemini on a technical question',
      '  status       Show background job status',
      '  result       Retrieve background job output',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const command = argv[0] ?? 'help';
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(arg);
    }
  }

  return { command, args, flags };
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'setup':
      await runSetup({
        check: flags['check'] === true,
        json: flags['json'] === true,
      });
      break;

    case 'investigate': {
      if (flags['background'] === true) {
        const jobId = enqueueBackground('investigate', args, flags, process.cwd());
        console.log(`Background job started: ${jobId}\nUse \`/gemini:status ${jobId}\` to check progress or \`/gemini:result ${jobId}\` when done.`);
        break;
      }
      const objective = args.join(' ') || String(flags['objective'] ?? '');
      await runInvestigate(objective, process.cwd(), {
        path: typeof flags['path'] === 'string' ? flags['path'] : undefined,
        forceStandard: flags['standard'] === true,
        writePath: typeof flags['write'] === 'string' ? flags['write'] : undefined,
      });
      break;
    }

    case 'analyze': {
      if (flags['background'] === true) {
        const jobId = enqueueBackground('analyze', args, flags, process.cwd());
        console.log(`Background job started: ${jobId}\nUse \`/gemini:status ${jobId}\` to check progress or \`/gemini:result ${jobId}\` when done.`);
        break;
      }
      await runAnalyze({
        path: typeof flags['path'] === 'string' ? flags['path'] : undefined,
        focus: typeof flags['focus'] === 'string' ? flags['focus'] : undefined,
        writePath: typeof flags['write'] === 'string' ? flags['write'] : undefined,
        forceStandard: flags['standard'] === true,
      });
      break;
    }

    case 'spec': {
      const conflictRaw = typeof flags['on-conflict'] === 'string' ? flags['on-conflict'] : 'abort';
      const onConflict = (['abort', 'keep', 'overwrite'].includes(conflictRaw) ? conflictRaw : 'abort') as
        | 'abort'
        | 'keep'
        | 'overwrite';
      await runSpec({
        cwd: typeof flags['path'] === 'string' ? flags['path'] : undefined,
        output: typeof flags['output'] === 'string' ? flags['output'] : undefined,
        full: flags['full'] === true,
        fromHash: typeof flags['from'] === 'string' ? flags['from'] : undefined,
        dryRun: flags['dry-run'] === true,
        onConflict,
        forceStandard: flags['standard'] === true,
      });
      break;
    }

    case 'opinion': {
      if (flags['background'] === true) {
        const jobId = enqueueBackground('opinion', args, flags, process.cwd());
        console.log(`Background job started: ${jobId}\nUse \`/gemini:status ${jobId}\` to check progress or \`/gemini:result ${jobId}\` when done.`);
        break;
      }
      const question = args.join(' ') || String(flags['question'] ?? '');
      await runOpinion(question, process.cwd(), {
        path: typeof flags['path'] === 'string' ? flags['path'] : undefined,
        forceStandard: flags['standard'] === true,
      });
      break;
    }

    case 'status':
      await runStatus(process.cwd(), {
        jobId: args[0],
        all: flags['all'] === true,
        json: flags['json'] === true,
      });
      break;

    case 'result':
      await runResult(process.cwd(), {
        jobId: args[0],
        json: flags['json'] === true,
      });
      break;

    // Internal: background worker entry point
    case '_worker': {
      const jobId = typeof flags['job-id'] === 'string' ? flags['job-id'] : '';
      const workerCwd = typeof flags['cwd'] === 'string' ? flags['cwd'] : process.cwd();
      if (!jobId) {
        console.error('Worker requires --job-id');
        process.exit(1);
      }
      await runWorker(jobId, workerCwd);
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      printUsage();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error(`\nFatal error: ${err.message}`);
  if (process.env['DEBUG']) console.error(err.stack);
  process.exit(1);
});
