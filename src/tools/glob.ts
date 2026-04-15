/**
 * glob tool — finds files matching glob patterns.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import type { FunctionDeclaration } from '../lib/types.js';

export const globDeclaration: FunctionDeclaration = {
  name: 'glob',
  description:
    'Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), ' +
    'returning absolute paths sorted by modification time (newest first).',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: "The glob pattern to match against (e.g., '**/*.py', 'docs/*.md').",
      },
      dir_path: {
        type: 'string',
        description:
          'Optional: The absolute path to the directory to search within. If omitted, searches the root directory.',
      },
    },
    required: ['pattern'],
  },
};

const PRUNE_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', '.nuxt',
  'coverage', '.cache', '__pycache__', 'venv', '.venv', 'vendor',
  'target', 'out', '.turbo', '.yarn',
]);

const MAX_RESULTS = 200;

interface FileEntry {
  path: string;
  mtime: number;
}

/**
 * Simple recursive glob implementation that avoids external dependencies.
 */
function walkAndMatch(
  dir: string,
  pattern: RegExp,
  results: FileEntry[],
  depth: number = 0,
): void {
  if (depth > 20 || results.length >= MAX_RESULTS) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (PRUNE_DIRS.has(name) || (name.startsWith('.') && depth === 0 && name !== '.')) continue;

    const fullPath = join(dir, name);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      walkAndMatch(fullPath, pattern, results, depth + 1);
    } else if (stat.isFile()) {
      if (pattern.test(fullPath) || pattern.test(name)) {
        results.push({ path: fullPath, mtime: stat.mtimeMs });
      }
    }

    if (results.length >= MAX_RESULTS) return;
  }
}

function globPatternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(escaped + '$', 'i');
}

export async function executeGlob(
  args: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const pattern = String(args['pattern'] ?? '');
  const dirPath = resolve(cwd, String(args['dir_path'] ?? cwd));

  if (!pattern) {
    return 'Error: pattern is required.';
  }

  const regex = globPatternToRegex(pattern);
  const results: FileEntry[] = [];
  walkAndMatch(dirPath, regex, results);

  // Sort by mtime descending (newest first)
  results.sort((a, b) => b.mtime - a.mtime);

  if (results.length === 0) {
    return `No files found matching pattern '${pattern}' in '${dirPath}'.`;
  }

  const paths = results.map(r => r.path);
  const truncated = results.length >= MAX_RESULTS ? `\n(Results limited to ${MAX_RESULTS} files.)` : '';

  return `Found ${results.length} file(s) matching '${pattern}':\n\n${paths.join('\n')}${truncated}`;
}
