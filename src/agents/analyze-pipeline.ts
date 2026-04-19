/**
 * Lightweight hybrid project analysis pipeline.
 *
 * Phase 1 (local, zero API calls): extract a structured project skeleton:
 *   - directory tree with module role inferred from path heuristics
 *   - exports / imports / doc comments extracted via regex (TS/JS/Go/Python)
 *   - package manifests parsed (package.json, go.mod, pyproject.toml, Cargo.toml)
 *   - README first N chars
 *
 * Phase 2 (single LLM call): synthesize the skeleton into a narrative report.
 *
 * Total API calls: 1 (regardless of project size). Rate limit accumulation is
 * eliminated — at worst we wait once on 429 and retry.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import type {
  GeminiClientInterface,
  GenerateContentResponse,
} from '../lib/types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const PRUNE_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', '.nuxt',
  'coverage', '.cache', '__pycache__', 'venv', '.venv', 'vendor',
  'target', 'out', '.turbo', '.yarn', '.svelte-kit',
  '__snapshots__', '__mocks__',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.py', '.rs', '.java', '.kt', '.rb',
]);

const MAX_FILES_PER_DIR = 20;
const MAX_EXPORTS_PER_FILE = 15;
const MAX_README_CHARS = 4000;
const MAX_SKELETON_CHARS = 250_000; // ~62k tokens; well within context

/** Fallback cheap model on rate limit */
const CHEAP_MODEL = 'gemini-2.5-flash';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FileInfo {
  path: string;
  exports: string[];
  docComment?: string;
  size: number;
}

interface ModuleInfo {
  path: string;
  files: FileInfo[];
  subdirs: string[];
  inferredRole?: string;
}

interface Manifest {
  kind: string;
  path: string;
  data: Record<string, unknown>;
}

interface ProjectSkeleton {
  root: string;
  readme: string | null;
  manifests: Manifest[];
  modules: ModuleInfo[];
  entryPoints: string[];
}

// ─── Phase 1: Local extraction ──────────────────────────────────────────────

function isCodeFile(name: string): boolean {
  return CODE_EXTENSIONS.has(extname(name).toLowerCase());
}

function inferModuleRole(dirPath: string): string | undefined {
  const parts = dirPath.toLowerCase().split('/');
  const last = parts[parts.length - 1] ?? '';
  const rules: Array<[RegExp, string]> = [
    [/^(src|lib|pkg|internal)$/, 'Main source code'],
    [/^(cmd|cli|bin)$/, 'Command-line entry points'],
    [/^(auth|authn|authz)$/, 'Authentication / authorization'],
    [/^(api|routes?|handlers?|controllers?|endpoints?)$/, 'HTTP / RPC routing layer'],
    [/^(db|database|storage|repos?|repositories?|dal|persistence)$/, 'Data persistence layer'],
    [/^(models?|entities|schemas?|domain)$/, 'Domain models / data schemas'],
    [/^(services?|usecases?|business)$/, 'Business logic / services'],
    [/^(client|clients?|sdk)$/, 'External API clients'],
    [/^(middleware|middlewares)$/, 'HTTP middleware'],
    [/^(utils?|helpers?|common|shared)$/, 'Shared utilities'],
    [/^(config|configs|settings)$/, 'Configuration'],
    [/^(types?|typings|interfaces?)$/, 'Type definitions'],
    [/^(tests?|__tests__|specs?)$/, 'Test suite'],
    [/^(migrations?|migrate)$/, 'Database migrations'],
    [/^(scripts?|tools?)$/, 'Build / dev scripts'],
    [/^(docs?|documentation)$/, 'Documentation'],
    [/^(public|static|assets)$/, 'Static assets'],
    [/^(components?|ui|views?|pages?)$/, 'UI components'],
    [/^(hooks?)$/, 'React hooks / reusable logic'],
    [/^(store|stores|state|reducers?)$/, 'State management'],
    [/^(agents?)$/, 'AI agents / orchestration'],
    [/^(commands?)$/, 'Command implementations'],
    [/^(tools?)$/, 'Tool implementations'],
  ];
  for (const [re, role] of rules) {
    if (re.test(last)) return role;
  }
  return undefined;
}

function extractExportsFromTS(content: string): string[] {
  const exports: string[] = [];
  const patterns = [
    /^export\s+(?:async\s+)?function\s+(\w+)/gm,
    /^export\s+(?:abstract\s+)?class\s+(\w+)/gm,
    /^export\s+(?:const|let|var)\s+(\w+)/gm,
    /^export\s+(?:type|interface)\s+(\w+)/gm,
    /^export\s+enum\s+(\w+)/gm,
    /^export\s+default\s+(?:class|function)\s+(\w+)/gm,
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(content)) !== null) exports.push(m[1]);
  }
  // Named re-exports: export { foo, bar }
  const reExport = /^export\s+\{\s*([^}]+)\s*\}/gm;
  let m;
  while ((m = reExport.exec(content)) !== null) {
    const names = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    exports.push(...names);
  }
  // export default (identifier or arrow)
  if (/^export\s+default\b/m.test(content) && !exports.includes('default')) {
    exports.push('default');
  }
  return dedup(exports).slice(0, MAX_EXPORTS_PER_FILE);
}

function extractExportsFromGo(content: string): string[] {
  const exports: string[] = [];
  const patterns = [
    // func Foo(...) or func (r *Recv) Foo(...)
    /^func\s+(?:\([^)]+\)\s+)?([A-Z]\w*)/gm,
    /^type\s+([A-Z]\w*)\s+(?:struct|interface|func|\w)/gm,
    /^var\s+([A-Z]\w*)/gm,
    /^const\s+([A-Z]\w*)/gm,
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(content)) !== null) exports.push(m[1]);
  }
  return dedup(exports).slice(0, MAX_EXPORTS_PER_FILE);
}

function extractExportsFromPython(content: string): string[] {
  const exports: string[] = [];
  // Top-level def/class (indent == 0)
  const p = /^(?:def|class)\s+([A-Za-z_]\w*)/gm;
  let m;
  while ((m = p.exec(content)) !== null) {
    const name = m[1];
    if (!name.startsWith('_')) exports.push(name);
  }
  return dedup(exports).slice(0, MAX_EXPORTS_PER_FILE);
}

function extractExports(content: string, ext: string): string[] {
  switch (ext) {
    case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': case '.cjs':
      return extractExportsFromTS(content);
    case '.go':
      return extractExportsFromGo(content);
    case '.py':
      return extractExportsFromPython(content);
    default:
      return [];
  }
}

function extractDocComment(content: string): string | undefined {
  // Match leading /** ... */ or leading // / # comments
  const blockMatch = /^\s*\/\*\*?\s*([\s\S]*?)\s*\*\//.exec(content);
  if (blockMatch) {
    const text = blockMatch[1].replace(/^\s*\*\s?/gm, '').trim();
    return text.split('\n')[0].slice(0, 200) || undefined;
  }
  const lineMatch = /^((?:\s*(?:\/\/|#).*\n)+)/.exec(content);
  if (lineMatch) {
    const text = lineMatch[1].replace(/^\s*(?:\/\/|#)\s?/gm, '').trim();
    return text.split('\n')[0].slice(0, 200) || undefined;
  }
  return undefined;
}

function dedup(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

function readManifests(rootPath: string): Manifest[] {
  const manifests: Manifest[] = [];
  const candidates = [
    { name: 'package.json', kind: 'npm' },
    { name: 'tsconfig.json', kind: 'typescript' },
    { name: 'go.mod', kind: 'go' },
    { name: 'pyproject.toml', kind: 'python' },
    { name: 'Cargo.toml', kind: 'rust' },
    { name: 'requirements.txt', kind: 'python-req' },
    { name: 'Dockerfile', kind: 'docker' },
    { name: 'docker-compose.yml', kind: 'docker-compose' },
    { name: 'docker-compose.yaml', kind: 'docker-compose' },
  ];
  for (const { name, kind } of candidates) {
    const p = join(rootPath, name);
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf-8');
      let data: Record<string, unknown> = {};
      if (name.endsWith('.json')) {
        try { data = JSON.parse(raw); } catch { data = { _raw: raw.slice(0, 2000) }; }
      } else {
        data = { _raw: raw.slice(0, 2000) };
      }
      manifests.push({ kind, path: name, data });
    } catch { /* skip */ }
  }
  return manifests;
}

function readReadme(rootPath: string): string | null {
  for (const name of ['README.md', 'README.rst', 'README.txt', 'README']) {
    const p = join(rootPath, name);
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf-8').slice(0, MAX_README_CHARS);
      } catch { /* skip */ }
    }
  }
  return null;
}

function inferEntryPoints(rootPath: string, manifests: Manifest[]): string[] {
  const entries = new Set<string>();
  // From package.json
  const pkg = manifests.find(m => m.kind === 'npm');
  if (pkg) {
    const d = pkg.data as Record<string, unknown>;
    if (typeof d.main === 'string') entries.add(d.main);
    if (typeof d.module === 'string') entries.add(d.module);
    if (d.bin && typeof d.bin === 'object') {
      for (const v of Object.values(d.bin)) {
        if (typeof v === 'string') entries.add(v);
      }
    } else if (typeof d.bin === 'string') {
      entries.add(d.bin);
    }
  }
  // Common filenames
  const common = ['main.go', 'cmd/main.go', 'main.py', '__main__.py', 'src/main.ts', 'src/index.ts', 'src/cli.ts', 'src/server.ts', 'index.ts', 'index.js', 'server.js'];
  for (const c of common) {
    if (existsSync(join(rootPath, c))) entries.add(c);
  }
  return Array.from(entries);
}

function scanModules(rootPath: string, dirPath: string, modules: ModuleInfo[]): void {
  const absDir = join(rootPath, dirPath);
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }

  const files: FileInfo[] = [];
  const subdirs: string[] = [];

  for (const name of entries.sort()) {
    if (name.startsWith('.') && dirPath === '') continue;
    if (PRUNE_DIRS.has(name)) continue;

    const relPath = dirPath ? `${dirPath}/${name}` : name;
    const absPath = join(rootPath, relPath);

    let stat;
    try { stat = statSync(absPath); } catch { continue; }

    if (stat.isDirectory()) {
      subdirs.push(relPath);
    } else if (stat.isFile() && isCodeFile(name) && files.length < MAX_FILES_PER_DIR) {
      try {
        const content = readFileSync(absPath, 'utf-8');
        const ext = extname(name).toLowerCase();
        files.push({
          path: relPath,
          exports: extractExports(content, ext),
          docComment: extractDocComment(content),
          size: stat.size,
        });
      } catch { /* skip */ }
    }
  }

  if (files.length > 0 || subdirs.length > 0) {
    modules.push({
      path: dirPath || '/',
      files,
      subdirs,
      inferredRole: inferModuleRole(dirPath || ''),
    });
  }

  for (const sub of subdirs) {
    scanModules(rootPath, sub, modules);
  }
}

export function buildProjectSkeleton(rootPath: string): ProjectSkeleton {
  const manifests = readManifests(rootPath);
  const readme = readReadme(rootPath);
  const entryPoints = inferEntryPoints(rootPath, manifests);
  const modules: ModuleInfo[] = [];
  scanModules(rootPath, '', modules);
  return { root: rootPath, readme, manifests, modules, entryPoints };
}

// ─── Phase 2: Single LLM call ───────────────────────────────────────────────

function formatSkeleton(skeleton: ProjectSkeleton): string {
  const parts: string[] = [];

  parts.push(`# Project: ${basename(skeleton.root)}`);
  parts.push(`Root: ${skeleton.root}`);
  parts.push('');

  if (skeleton.readme) {
    parts.push('## README (authoritative description of project intent)');
    parts.push(skeleton.readme);
    parts.push('');
  }

  if (skeleton.manifests.length > 0) {
    parts.push('## Manifests');
    for (const m of skeleton.manifests) {
      parts.push(`### ${m.path} [${m.kind}]`);
      // For package.json, show selected fields to keep it compact
      if (m.kind === 'npm') {
        const d = m.data as Record<string, unknown>;
        const selected = {
          name: d.name, version: d.version, description: d.description,
          main: d.main, bin: d.bin, type: d.type,
          scripts: d.scripts,
          dependencies: d.dependencies, devDependencies: d.devDependencies,
        };
        parts.push('```json');
        parts.push(JSON.stringify(selected, null, 2));
        parts.push('```');
      } else if (m.kind === 'typescript') {
        const d = m.data as Record<string, unknown>;
        const selected = { compilerOptions: d.compilerOptions, include: d.include };
        parts.push('```json');
        parts.push(JSON.stringify(selected, null, 2));
        parts.push('```');
      } else {
        parts.push('```');
        parts.push(typeof m.data._raw === 'string' ? m.data._raw : JSON.stringify(m.data));
        parts.push('```');
      }
      parts.push('');
    }
  }

  if (skeleton.entryPoints.length > 0) {
    parts.push('## Entry Points (detected)');
    for (const e of skeleton.entryPoints) parts.push(`- ${e}`);
    parts.push('');
  }

  parts.push('## Module Structure');
  for (const m of skeleton.modules) {
    const role = m.inferredRole ? ` — _${m.inferredRole}_` : '';
    parts.push(`### ${m.path}${role}`);
    if (m.subdirs.length > 0) {
      parts.push(`  Subdirs: ${m.subdirs.map(s => basename(s)).join(', ')}`);
    }
    for (const f of m.files) {
      const fname = basename(f.path);
      const ex = f.exports.length > 0 ? ` → exports: ${f.exports.join(', ')}` : '';
      const doc = f.docComment ? `\n    // ${f.docComment}` : '';
      parts.push(`  - ${fname}${ex}${doc}`);
    }
    parts.push('');
  }

  let text = parts.join('\n');
  if (text.length > MAX_SKELETON_CHARS) {
    text = text.slice(0, MAX_SKELETON_CHARS) + '\n\n...(truncated)';
  }
  return text;
}

function buildSynthesisPrompt(skeleton: ProjectSkeleton): string {
  return `You are writing a rough architecture document for a codebase. I have pre-extracted the project's structure below — you do NOT need to read source code. Base your analysis entirely on this skeleton.

Treat the README (if present) as the authoritative statement of project intent. Let it shape your high-level framing. Everything else (manifests, module structure, exports) is for grounding specific technical claims.

${formatSkeleton(skeleton)}

---

Write a Markdown document using EXACTLY the structure below. The tone should read like a hand-written rough architecture doc a senior engineer would give a new hire — informative, grounded, scannable, not marketing.

# Project Context

## Overview
4-8 sentences. What this project is, the problem it solves, the core design philosophy. Ground this in the README if available.

## Tech Stack
- **Language / Runtime:** ...
- **Frameworks:** ...
- **Key Dependencies:** bullet list of 5-10 notable deps with a brief purpose each (why this project uses them).

## Module Summary
A compact table for quick scanning. Include every module you'll describe in detail below.

| Module | Layer | Purpose |
|---|---|---|
| \`path/\` | Domain / Infrastructure / Transport / Cross-cutting / Utilities | One-line purpose |

Use these layer categories consistently:
- **Domain** — business/game/product logic (e.g. \`module/character/\`, \`src/services/\`)
- **Infrastructure** — DB, cache, messaging, scheduling wrappers (e.g. \`pkg/database/\`)
- **Transport** — HTTP/RPC/WebSocket entry points and routing (e.g. \`router/\`, \`src/routes/\`)
- **Cross-cutting** — shared concerns: auth, logging, metrics, event bus
- **Utilities** — small helpers, type defs, config

## Module Details
Aim for **15-30 modules**. For large projects, go down to the second level (e.g. \`module/character/\`, not just \`module/\`). Group modules by layer using ### Layer headers, then ####-level module entries under each.

### Domain
#### \`path/to/module/\`
- **Responsibility:** 1-2 sentences — what this module owns.
- **Sub-systems:** (omit this field if none) Bullet list of notable internal concepts / features grounded in subdirs or exports. e.g. "Perk Tree (\`module/character/perk/\`) — non-linear growth system"
- **Notable details:** (omit this field if none) Anything interesting: storage strategy, integration with other modules, unusual patterns. 1-2 sentences or 1-3 bullets.

### Infrastructure
#### \`pkg/database/\`
- **Responsibility:** ...
- (same sub-fields as above, omit any that don't apply)

### Transport
(continue with same structure)

### Cross-cutting
(if applicable)

### Utilities
(if applicable)

## Conventions & Patterns
Detected patterns across the codebase (Repository Pattern, Middleware DI, Functional Options, etc.). 3-6 items. For each:
- **Pattern Name:** short description, then 1-2 file examples in backticks.

Be specific to THIS codebase — no generic advice.

## Entry Points
- \`path\` — 1 sentence: what it does, when it's invoked.

## Architecture Notes
5-10 sentences of prose. Layering, data flow, module boundaries, noteworthy trade-offs or design decisions visible from the structure.

If the data flow is non-trivial and can be clearly expressed as an ASCII diagram (e.g. request lifecycle across layers), include one inside a fenced code block. Only do this when it genuinely aids understanding; skip it otherwise.

---

Guidelines:
- Ground every claim in the skeleton data — file names, exports, dependencies. If you're not sure, omit it.
- For module descriptions, actively look at subdirs and exports to identify notable sub-systems worth naming.
- Omit sub-fields ("Sub-systems", "Notable details") when you have nothing substantive to say — don't pad.
- The Module Summary table and Module Details must reference the SAME modules in the same order.
- Don't invent features that aren't supported by the skeleton.
- Respond with the Markdown document directly. Do NOT wrap in code fences. Do NOT add any preamble or explanation.`;
}

async function synthesize(
  client: GeminiClientInterface,
  skeleton: ProjectSkeleton,
  primaryModel: string,
): Promise<string> {
  const prompt = buildSynthesisPrompt(skeleton);
  progress(`Synthesizing report [${primaryModel}] (prompt: ${Math.round(prompt.length / 1024)}KB)...`);

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

  progress('Phase 1: Extracting project skeleton (local)...');
  const skeleton = buildProjectSkeleton(scanRoot);
  const moduleCount = skeleton.modules.length;
  const fileCount = skeleton.modules.reduce((s, m) => s + m.files.length, 0);
  progress(`  Found ${moduleCount} modules, ${fileCount} code files, ${skeleton.manifests.length} manifests.`);

  if (moduleCount === 0 && skeleton.manifests.length === 0) {
    return JSON.stringify({ ProjectSummary: 'No source files or manifests found.', ModuleMap: [], Conventions: [], EntryPoints: [] });
  }

  progress('Phase 2: Synthesizing narrative report (1 API call)...');
  return await synthesize(client, skeleton, primaryModel);
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
