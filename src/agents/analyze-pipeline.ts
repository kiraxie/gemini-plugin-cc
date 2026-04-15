/**
 * DFS-based codebase analysis pipeline.
 *
 * Instead of an agent loop (many turns, one file per turn), this pipeline:
 * 1. Locally scans the directory tree (zero API calls)
 * 2. Batches files by directory and summarizes each (1 API call per directory)
 * 3. Synthesizes all summaries into a final report (1 API call)
 *
 * Model tiering:
 * - Small/simple directories → gemini-2.5-flash (cheap, fast)
 * - Large/complex directories → primary model (gemini-3-flash-preview or fallback)
 * - Final synthesis → primary model
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import type {
  GeminiClientInterface,
  GenerateContentResponse,
  Content,
  Part,
} from '../lib/types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const PRUNE_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', '.nuxt',
  'coverage', '.cache', '__pycache__', 'venv', '.venv', 'vendor',
  'target', 'out', '.turbo', '.yarn', '.svelte-kit',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.py', '.rs', '.java', '.kt', '.rb', '.php', '.c', '.h', '.cpp', '.hpp',
  '.css', '.scss', '.html', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.xml',
  '.md', '.txt', '.sh', '.bash', '.zsh',
  '.sql', '.graphql', '.proto',
  '.env', '.gitignore', '.dockerignore',
  '', // files without extension (Makefile, Dockerfile, etc.)
]);

/** Threshold for "simple" directory: use cheap model */
const SIMPLE_FILE_COUNT = 5;
const SIMPLE_TOTAL_SIZE = 20_000; // 20KB

/** Max content per directory batch to avoid context overflow */
const MAX_BATCH_SIZE = 100_000; // 100KB

/** Models */
const CHEAP_MODEL = 'gemini-2.5-flash';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FileEntry {
  path: string;       // relative to project root
  content: string;
  size: number;
}

interface DirectoryBatch {
  dirPath: string;    // relative to project root
  files: FileEntry[];
  totalSize: number;
  isSimple: boolean;
}

export interface DirectorySummary {
  dirPath: string;
  summary: string;
  keyFiles: string[];
  keyExports: string[];
  patterns: string[];
}

export interface AnalysisPipelineResult {
  summaries: DirectorySummary[];
  finalReport: string;
}

// ─── Phase 1: Local DFS Scan ─────────────────────────────────────────────────

function isTextFile(name: string): boolean {
  const ext = extname(name).toLowerCase();
  // Handle extensionless files
  if (ext === '') {
    const known = ['Makefile', 'Dockerfile', 'Procfile', 'Gemfile', 'Rakefile', 'Vagrantfile'];
    return known.includes(name) || name.startsWith('.');
  }
  return TEXT_EXTENSIONS.has(ext);
}

function scanDirectory(rootPath: string, dirPath: string, batches: DirectoryBatch[]): void {
  const absDir = join(rootPath, dirPath);
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }

  const files: FileEntry[] = [];
  const subdirs: string[] = [];

  for (const name of entries.sort()) {
    if (name.startsWith('.') && dirPath === '') continue; // skip hidden at root except in subdirs
    if (PRUNE_DIRS.has(name)) continue;

    const relPath = dirPath ? `${dirPath}/${name}` : name;
    const absPath = join(rootPath, relPath);

    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      subdirs.push(relPath);
    } else if (stat.isFile() && isTextFile(name)) {
      if (stat.size > MAX_BATCH_SIZE) {
        // Large file: truncate
        try {
          const content = readFileSync(absPath, 'utf-8').slice(0, MAX_BATCH_SIZE);
          files.push({ path: relPath, content, size: stat.size });
        } catch { /* skip unreadable */ }
      } else if (stat.size > 0) {
        try {
          const content = readFileSync(absPath, 'utf-8');
          files.push({ path: relPath, content, size: stat.size });
        } catch { /* skip */ }
      }
    }
  }

  // Add this directory's files as a batch (if any)
  if (files.length > 0) {
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    batches.push({
      dirPath: dirPath || '/',
      files,
      totalSize,
      isSimple: files.length <= SIMPLE_FILE_COUNT && totalSize <= SIMPLE_TOTAL_SIZE,
    });
  }

  // DFS into subdirs
  for (const sub of subdirs) {
    scanDirectory(rootPath, sub, batches);
  }
}

export function buildDirectoryBatches(rootPath: string): DirectoryBatch[] {
  const batches: DirectoryBatch[] = [];
  scanDirectory(rootPath, '', batches);
  return batches;
}

// ─── Phase 2: Per-Directory Summarization ────────────────────────────────────

function buildDirectoryPrompt(batch: DirectoryBatch): string {
  const fileList = batch.files.map(f => `- ${f.path} (${f.size} bytes)`).join('\n');

  // Truncate total content if needed
  let totalContent = '';
  let budget = MAX_BATCH_SIZE;
  for (const file of batch.files) {
    if (budget <= 0) break;
    const slice = file.content.slice(0, budget);
    totalContent += `\n--- FILE: ${file.path} ---\n${slice}\n`;
    budget -= slice.length;
  }

  return `Analyze the following directory and its files. Produce a concise summary.

Directory: ${batch.dirPath}
Files:
${fileList}

<source_code>
${totalContent}
</source_code>

Respond with a JSON object:
{
  "summary": "What this directory/module is responsible for (1-3 sentences)",
  "keyFiles": ["most important files"],
  "keyExports": ["key exported symbols (functions, classes, types, interfaces)"],
  "patterns": ["design patterns or conventions observed (e.g. 'Functional Options', 'Repository Pattern')"]
}

Respond ONLY with the JSON object, no markdown fences, no explanation.`;
}

async function summarizeDirectory(
  client: GeminiClientInterface,
  batch: DirectoryBatch,
  primaryModel: string,
): Promise<DirectorySummary> {
  const model = batch.isSimple ? CHEAP_MODEL : primaryModel;
  const prompt = buildDirectoryPrompt(batch);

  progress(`  [${model}] ${batch.dirPath} (${batch.files.length} files, ${Math.round(batch.totalSize / 1024)}KB)`);

  try {
    const response = await client.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const text = extractText(response);
    try {
      const parsed = JSON.parse(text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      return {
        dirPath: batch.dirPath,
        summary: parsed.summary ?? '',
        keyFiles: parsed.keyFiles ?? [],
        keyExports: parsed.keyExports ?? [],
        patterns: parsed.patterns ?? [],
      };
    } catch {
      return {
        dirPath: batch.dirPath,
        summary: text.slice(0, 500),
        keyFiles: batch.files.map(f => f.path),
        keyExports: [],
        patterns: [],
      };
    }
  } catch (err) {
    // On rate limit: wait briefly then retry with cheap model (or same model if already cheap)
    if (isRateLimitError(err)) {
      const waitSec = extractWaitTime(err);
      const retryModel = model !== CHEAP_MODEL ? CHEAP_MODEL : model;
      progress(`  Rate limited on ${model}. Waiting ${waitSec}s then retrying with ${retryModel}...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return summarizeDirectory(client, { ...batch, isSimple: true }, retryModel);
    }
    return {
      dirPath: batch.dirPath,
      summary: `(analysis failed: ${(err as Error).message})`,
      keyFiles: batch.files.map(f => f.path),
      keyExports: [],
      patterns: [],
    };
  }
}

// ─── Phase 3: Synthesis ──────────────────────────────────────────────────────

function buildSynthesisPrompt(summaries: DirectorySummary[], rootPath: string): string {
  const moduleSections = summaries.map(s => {
    const exports = s.keyExports.length > 0 ? `\nKey exports: ${s.keyExports.join(', ')}` : '';
    const patterns = s.patterns.length > 0 ? `\nPatterns: ${s.patterns.join(', ')}` : '';
    return `### ${s.dirPath}\n${s.summary}${exports}${patterns}`;
  }).join('\n\n');

  return `You are producing a project context document from directory-level summaries.
Synthesize the following module summaries into a comprehensive project overview.

Project root: ${rootPath}

${moduleSections}

Respond with a JSON object:
{
  "ProjectSummary": "What this project is, what problem it solves, its core design philosophy (2-4 sentences)",
  "TechStack": {
    "language": "primary language",
    "framework": "main framework if any",
    "keyDependencies": [{"name": "dep-name", "purpose": "what it's used for"}]
  },
  "ModuleMap": [{"path": "dir/", "role": "what this module does", "keyFiles": ["file1.ts"], "keyExports": ["Symbol1"]}],
  "Conventions": [{"pattern": "Pattern Name", "description": "how it's used", "examples": ["file.ts"]}],
  "EntryPoints": [{"path": "main.ts", "description": "what this entry point does"}],
  "ArchitectureNotes": "Key architectural decisions, trade-offs, gotchas (free-form text)"
}

Respond ONLY with the JSON object, no markdown fences.`;
}

async function synthesize(
  client: GeminiClientInterface,
  summaries: DirectorySummary[],
  rootPath: string,
  primaryModel: string,
): Promise<string> {
  const prompt = buildSynthesisPrompt(summaries, rootPath);

  progress(`Synthesizing final report [${primaryModel}]...`);

  try {
    const response = await client.generateContent({
      model: primaryModel,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        topP: 0.95,
        thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 },
      },
    });
    return extractText(response);
  } catch (err) {
    if (isRateLimitError(err)) {
      const waitSec = extractWaitTime(err);
      const retryModel = primaryModel !== CHEAP_MODEL ? CHEAP_MODEL : primaryModel;
      progress(`Rate limited on ${primaryModel}. Waiting ${waitSec}s then retrying with ${retryModel}...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      const response = await client.generateContent({
        model: retryModel,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, topP: 0.95 },
      });
      return extractText(response);
    }
    throw err;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function runAnalyzePipeline(
  client: GeminiClientInterface,
  rootPath: string,
  primaryModel: string,
  focus?: string,
): Promise<string> {
  const scanRoot = focus ? join(rootPath, focus) : rootPath;

  // Phase 1: Local scan
  progress('Phase 1: Scanning directory tree...');
  const batches = buildDirectoryBatches(scanRoot);
  progress(`  Found ${batches.length} directories with source files.`);

  if (batches.length === 0) {
    return JSON.stringify({ ProjectSummary: 'No source files found.', ModuleMap: [], Conventions: [], EntryPoints: [] });
  }

  // Phase 2: Per-directory summarization
  progress(`Phase 2: Summarizing ${batches.length} directories...`);
  const summaries: DirectorySummary[] = [];
  for (const batch of batches) {
    const summary = await summarizeDirectory(client, batch, primaryModel);
    summaries.push(summary);
  }

  // Phase 3: Synthesis
  progress('Phase 3: Synthesizing final report...');
  return await synthesize(client, summaries, rootPath, primaryModel);
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function extractText(response: GenerateContentResponse): string {
  const parts: string[] = [];
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.text && !part.thought) {
        parts.push(part.text);
      }
    }
  }
  return parts.join('');
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') || msg.includes('exhausted');
}

function extractWaitTime(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const match = /reset after (\d+)s/.exec(msg);
  return match ? parseInt(match[1], 10) + 2 : 10;
}

function progress(message: string): void {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.error(`[${time}] ${message}`);
}
