#!/usr/bin/env node

/**
 * gemini-companion — CLI entry point for the Gemini Claude Code plugin.
 *
 * Usage:
 *   node dist/gemini-companion.js setup [--check] [--json]
 *   node dist/gemini-companion.js investigate "<objective>"
 *   node dist/gemini-companion.js analyze [--path <dir>] [--focus <path>]
 */

import process from 'node:process';
import { runSetup } from './commands/setup.js';
import { runInvestigate } from './commands/investigate.js';
import { runAnalyze } from './commands/analyze.js';

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  gemini-companion setup [--check] [--json]',
      '  gemini-companion investigate "<objective>" [--path <dir>] [--write <path>] [--standard]',
      '  gemini-companion analyze [--path <dir>] [--focus <area>] [--write <path>] [--standard]',
      '',
      'Commands:',
      '  setup        Check authentication status and plugin readiness',
      '  investigate   Run a deep Gemini-powered codebase investigation',
      '  analyze      Produce a project context document using Gemini',
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
      const objective = args.join(' ') || String(flags['objective'] ?? '');
      await runInvestigate(objective, process.cwd(), {
        path: typeof flags['path'] === 'string' ? flags['path'] : undefined,
        forceStandard: flags['standard'] === true,
        writePath: typeof flags['write'] === 'string' ? flags['write'] : undefined,
      });
      break;
    }

    case 'analyze':
      await runAnalyze({
        path: typeof flags['path'] === 'string' ? flags['path'] : undefined,
        focus: typeof flags['focus'] === 'string' ? flags['focus'] : undefined,
        writePath: typeof flags['write'] === 'string' ? flags['write'] : undefined,
        forceStandard: flags['standard'] === true,
      });
      break;

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
