/**
 * Tool registry: maps tool names to declarations and implementations.
 */

import type { FunctionDeclaration } from '../lib/types.js';
import { listDirectoryDeclaration, executeListDirectory } from './list-directory.js';
import { readFileDeclaration, executeReadFile } from './read-file.js';
import { globDeclaration, executeGlob } from './glob.js';
import { grepSearchDeclaration, executeGrepSearch } from './grep-search.js';
import { webFetchDeclaration, executeWebFetch } from './web-fetch.js';

export interface ToolEntry {
  declaration: FunctionDeclaration;
  execute: (args: Record<string, unknown>, cwd: string) => Promise<string>;
}

const tools: Map<string, ToolEntry> = new Map([
  ['list_directory', { declaration: listDirectoryDeclaration, execute: executeListDirectory }],
  ['read_file', { declaration: readFileDeclaration, execute: executeReadFile }],
  ['glob', { declaration: globDeclaration, execute: executeGlob }],
  ['grep_search', { declaration: grepSearchDeclaration, execute: executeGrepSearch }],
  ['web_fetch', { declaration: webFetchDeclaration, execute: executeWebFetch }],
]);

export function getToolDeclarations(): FunctionDeclaration[] {
  return [...tools.values()].map(t => t.declaration);
}

export function getToolNames(): string[] {
  return [...tools.keys()];
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const entry = tools.get(name);
  if (!entry) {
    return `Error: Unknown tool '${name}'. Available tools: ${[...tools.keys()].join(', ')}`;
  }
  try {
    return await entry.execute(args, cwd);
  } catch (err) {
    return `Error executing tool '${name}': ${err instanceof Error ? err.message : String(err)}`;
  }
}
