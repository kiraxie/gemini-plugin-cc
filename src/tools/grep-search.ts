/**
 * grep_search tool — searches for regex patterns in files.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { FunctionDeclaration } from '../lib/types.js';

export const grepSearchDeclaration: FunctionDeclaration = {
  name: 'grep_search',
  description: 'Searches for a regular expression pattern within file contents. Max 100 matches.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          "The regular expression (regex) pattern to search for within file contents " +
          "(e.g., 'function\\s+myFunction', 'import\\s+\\{.*\\}\\s+from\\s+.*').",
      },
      dir_path: {
        type: 'string',
        description:
          'Optional: The absolute path to the directory to search within. If omitted, searches the current working directory.',
      },
      include_pattern: {
        type: 'string',
        description:
          "Optional: A glob pattern to filter which files are searched (e.g., '*.js', '*.{ts,tsx}').",
      },
      names_only: {
        type: 'boolean',
        description:
          'Optional: If true, only the file paths of the matches will be returned, without the line content.',
      },
    },
    required: ['pattern'],
  },
};

const DEFAULT_MAX_MATCHES = 100;
const TIMEOUT_MS = 30_000;

export async function executeGrepSearch(
  args: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const pattern = String(args['pattern'] ?? '');
  const dirPath = resolve(cwd, String(args['dir_path'] ?? cwd));
  const includePattern = args['include_pattern'] as string | undefined;
  const namesOnly = args['names_only'] as boolean | undefined;

  if (!pattern) {
    return 'Error: pattern is required.';
  }

  // Prefer ripgrep (rg) if available, otherwise fall back to grep
  const hasRg = (() => {
    try {
      execSync('which rg', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  })();

  let cmd: string;
  if (hasRg) {
    const parts = ['rg', '--no-heading', '--line-number', '--color=never'];
    if (namesOnly) parts.push('--files-with-matches');
    if (includePattern) parts.push(`--glob='${includePattern}'`);
    parts.push(`--max-count=${DEFAULT_MAX_MATCHES}`);
    parts.push(`-- '${pattern.replace(/'/g, "'\\''")}'`);
    parts.push(`'${dirPath.replace(/'/g, "'\\''")}'`);
    cmd = parts.join(' ');
  } else {
    const parts = ['grep', '-rn', '--color=never'];
    if (namesOnly) parts.push('-l');
    if (includePattern) parts.push(`--include='${includePattern}'`);
    parts.push(`-m ${DEFAULT_MAX_MATCHES}`);
    parts.push(`-E '${pattern.replace(/'/g, "'\\''")}'`);
    parts.push(`'${dirPath.replace(/'/g, "'\\''")}'`);
    cmd = parts.join(' ');
  }

  let output: string;
  try {
    output = execSync(cmd, {
      cwd: dirPath,
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const error = err as { status?: number; stdout?: string; stderr?: string };
    if (error.status === 1) {
      // No matches found (normal for grep)
      return `No matches found for pattern '${pattern}' in '${dirPath}'.`;
    }
    if (error.stdout) {
      output = error.stdout;
    } else {
      return `Error executing search: ${error.stderr ?? String(err)}`;
    }
  }

  const lines = output.trim().split('\n').filter(Boolean);
  const resultCount = lines.length;
  const truncated = resultCount >= DEFAULT_MAX_MATCHES
    ? `\n\n(Results limited to ${DEFAULT_MAX_MATCHES} matches. Narrow your search for more specific results.)`
    : '';

  return `Found ${resultCount} match(es) for '${pattern}':\n\n${lines.join('\n')}${truncated}`;
}
