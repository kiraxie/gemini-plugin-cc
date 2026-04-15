/**
 * read_file tool — reads file content with optional line range.
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FunctionDeclaration } from '../lib/types.js';

const MAX_CONTENT_LENGTH = 100_000; // 100KB

export const readFileDeclaration: FunctionDeclaration = {
  name: 'read_file',
  description:
    "Reads and returns the content of a specified file. If the file is large, the content will be truncated. " +
    "Use 'start_line' and 'end_line' parameters to read specific line ranges.",
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file to read.',
      },
      start_line: {
        type: 'number',
        description: 'Optional: The 1-based line number to start reading from.',
      },
      end_line: {
        type: 'number',
        description: 'Optional: The 1-based line number to end reading at (inclusive).',
      },
    },
    required: ['file_path'],
  },
};

export async function executeReadFile(
  args: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const filePath = resolve(cwd, String(args['file_path'] ?? ''));
  const startLine = args['start_line'] as number | undefined;
  const endLine = args['end_line'] as number | undefined;

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return `Error: File not found: '${filePath}'`;
  }

  if (stat.isDirectory()) {
    return `Error: '${filePath}' is a directory, not a file. Use list_directory instead.`;
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return `Error: Cannot read file '${filePath}': ${(err as Error).message}`;
  }

  const allLines = content.split('\n');
  const totalLines = allLines.length;

  // Apply line range
  let lines = allLines;
  let rangeStart = 1;
  let rangeEnd = totalLines;

  if (startLine !== undefined && startLine >= 1) {
    rangeStart = startLine;
  }
  if (endLine !== undefined && endLine >= rangeStart) {
    rangeEnd = Math.min(endLine, totalLines);
  }

  lines = allLines.slice(rangeStart - 1, rangeEnd);

  // Add line numbers
  const numbered = lines.map((line, i) => `${rangeStart + i}\t${line}`);
  let result = numbered.join('\n');

  // Truncate if too large
  let truncated = false;
  if (result.length > MAX_CONTENT_LENGTH) {
    result = result.slice(0, MAX_CONTENT_LENGTH);
    truncated = true;
  }

  const header = `File: ${filePath}\nShowing lines ${rangeStart}-${rangeEnd} of ${totalLines} total.`;
  const footer = truncated
    ? '\n\n... [Content truncated due to size limit. Use start_line and end_line to read specific ranges.] ...'
    : '';

  return `${header}\n\n${result}${footer}`;
}
