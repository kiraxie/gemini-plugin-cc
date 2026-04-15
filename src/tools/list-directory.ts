/**
 * list_directory tool — lists direct children of a directory.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FunctionDeclaration } from '../lib/types.js';

export const listDirectoryDeclaration: FunctionDeclaration = {
  name: 'list_directory',
  description:
    'Lists the names of files and subdirectories directly within a specified directory path.',
  parameters: {
    type: 'object',
    properties: {
      dir_path: {
        type: 'string',
        description: 'The path to the directory to list.',
      },
      ignore: {
        type: 'array',
        description: 'List of glob patterns to ignore.',
        items: { type: 'string' },
      },
    },
    required: ['dir_path'],
  },
};

const PRUNE_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', '.nuxt',
  'coverage', '.cache', '__pycache__', 'venv', '.venv', 'vendor',
  'target', 'out', '.turbo', '.yarn',
]);

export async function executeListDirectory(
  args: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const dirPath = resolve(cwd, String(args['dir_path'] ?? '.'));
  const ignorePatterns = (args['ignore'] as string[] | undefined) ?? [];

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err) {
    return `Error: Cannot read directory '${dirPath}': ${(err as Error).message}`;
  }

  // Filter pruned directories
  entries = entries.filter(name => !PRUNE_DIRS.has(name));

  // Apply simple ignore patterns
  if (ignorePatterns.length > 0) {
    const regexes = ignorePatterns.map(p =>
      new RegExp('^' + p.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'),
    );
    entries = entries.filter(name => !regexes.some(r => r.test(name)));
  }

  const lines: string[] = [];
  for (const name of entries.sort()) {
    try {
      const fullPath = join(dirPath, name);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        lines.push(`[DIR] ${name}`);
      } else {
        lines.push(`${name} (${stat.size} bytes)`);
      }
    } catch {
      lines.push(`${name} (stat error)`);
    }
  }

  return `Directory: ${dirPath}\nEntries: ${lines.length}\n\n${lines.join('\n')}`;
}
