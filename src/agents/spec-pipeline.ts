/**
 * SPEC reverse-engineering pipeline.
 *
 * Generates a non-engineer-facing functional specification (`docs/SPEC.md`)
 * from the codebase. Two modes:
 *
 *   - Full: scans the entire project, asks Gemini to enumerate every feature
 *     with purpose / users / inputs / outputs / examples / constraints, sorted
 *     by importance.
 *
 *   - Incremental: reads the existing SPEC.md, compares each section's
 *     `sources` glob against `git diff <last-updated>..HEAD`, and asks Gemini
 *     to update only affected sections (plus add new ones for files not yet
 *     covered). Manual edits are detected via content hash and respected
 *     according to the conflict strategy.
 *
 * Single LLM call per mode (consistent with the analyze pipeline rework).
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { GeminiClientInterface, GenerateContentResponse } from '../lib/types.js';
import { buildProjectSkeleton } from './analyze-pipeline.js';
import {
  type FeatureSpec,
  type ParsedSpec,
  type SpecMeta,
  type SpecSection,
  type SpecExample,
  type SpecField,
  detectManualEdit,
  parseSpecDocument,
  renderSection,
  renderSpecDocument,
} from '../lib/spec-renderer.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_CHANGED_FILE_CHARS = 8_000;
const MAX_CHANGED_FILES_INCLUDED = 30;
const MAX_SKELETON_CHARS = 200_000;

const CHEAP_MODEL = 'gemini-2.5-flash';

// ─── Public types ────────────────────────────────────────────────────────────

export type ConflictStrategy = 'abort' | 'keep' | 'overwrite';

export interface SpecPipelineOptions {
  cwd: string;
  outputPath: string;
  primaryModel: string;
  full?: boolean;
  fromHash?: string;
  dryRun?: boolean;
  onConflict?: ConflictStrategy;
}

export interface SpecPipelineResult {
  mode: 'full' | 'incremental';
  headHash: string;
  document: string;
  changedSections: string[];
  newSections: string[];
  skippedSections: string[];
  manualEditedSections: string[];
  dryRun: boolean;
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execSync(`git ${args.join(' ')}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function isGitRepo(cwd: string): boolean {
  try {
    git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

function getHeadHash(cwd: string): string {
  return git(['rev-parse', 'HEAD'], cwd);
}

function commitExists(hash: string, cwd: string): boolean {
  try {
    git(['cat-file', '-e', `${hash}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

function diffChangedFiles(fromHash: string, cwd: string): string[] {
  const out = git(['diff', '--name-only', `${fromHash}..HEAD`], cwd);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// ─── Source matching ────────────────────────────────────────────────────────

/**
 * Returns true if `file` is "covered" by any of the source patterns. A pattern
 * ending in `/` matches files under that directory; otherwise it must match
 * the file path exactly or as a prefix path component.
 */
function fileMatchesSources(file: string, sources: string[]): boolean {
  for (const src of sources) {
    if (src.endsWith('/')) {
      if (file === src.slice(0, -1) || file.startsWith(src)) return true;
    } else if (file === src || file.startsWith(src + '/')) {
      return true;
    }
  }
  return false;
}

// ─── Incremental change planning ────────────────────────────────────────────

interface ChangePlan {
  sectionsToRegenerate: SpecSection[];
  sectionsToKeep: SpecSection[];
  uncoveredChangedFiles: string[];
  manualEditedSections: SpecSection[];
}

function planIncrementalChanges(
  existing: ParsedSpec,
  changedFiles: string[],
  conflictStrategy: ConflictStrategy,
): ChangePlan {
  const sectionsToRegenerate: SpecSection[] = [];
  const sectionsToKeep: SpecSection[] = [];
  const manualEditedSections: SpecSection[] = [];
  const consumedFiles = new Set<string>();

  for (const section of existing.sections) {
    const sectionChangedFiles = changedFiles.filter((f) =>
      fileMatchesSources(f, section.feature.sources),
    );
    sectionChangedFiles.forEach((f) => consumedFiles.add(f));

    const wasEdited = detectManualEdit(section);
    if (wasEdited) manualEditedSections.push(section);

    const needsUpdate = sectionChangedFiles.length > 0;
    if (!needsUpdate) {
      sectionsToKeep.push(section);
      continue;
    }

    if (wasEdited && conflictStrategy === 'keep') {
      sectionsToKeep.push(section);
      continue;
    }
    sectionsToRegenerate.push(section);
  }

  const uncoveredChangedFiles = changedFiles.filter((f) => !consumedFiles.has(f));

  return { sectionsToRegenerate, sectionsToKeep, uncoveredChangedFiles, manualEditedSections };
}

// ─── Changed file content snapshot ──────────────────────────────────────────

interface ChangedFileSnapshot {
  path: string;
  content: string;
  truncated: boolean;
}

function readChangedFiles(cwd: string, files: string[]): ChangedFileSnapshot[] {
  const snapshots: ChangedFileSnapshot[] = [];
  for (const f of files.slice(0, MAX_CHANGED_FILES_INCLUDED)) {
    const abs = join(cwd, f);
    if (!existsSync(abs)) {
      snapshots.push({ path: f, content: '(file deleted)', truncated: false });
      continue;
    }
    try {
      const stat = statSync(abs);
      if (!stat.isFile()) continue;
      const raw = readFileSync(abs, 'utf-8');
      const truncated = raw.length > MAX_CHANGED_FILE_CHARS;
      snapshots.push({
        path: f,
        content: truncated ? raw.slice(0, MAX_CHANGED_FILE_CHARS) : raw,
        truncated,
      });
    } catch {
      snapshots.push({ path: f, content: '(read failed)', truncated: false });
    }
  }
  return snapshots;
}

// ─── Project type pre-detection (heuristic) ─────────────────────────────────

/**
 * Cheap local heuristic to seed the LLM with a project-type hint. The model
 * may override this in the JSON it returns.
 */
function detectProjectTypeHint(cwd: string): string {
  if (existsSync(join(cwd, '.claude-plugin'))) return 'claude-code-plugin';
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'rust-project';
  if (existsSync(join(cwd, 'go.mod'))) {
    if (anyFileMatches(cwd, /(?:router|gin|echo|fiber|chi|http\.HandleFunc)/)) {
      return 'go-web-service';
    }
    return 'go-cli-or-library';
  }
  if (existsSync(join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
      if (pkg.bin) return 'node-cli';
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps['next'] || deps['react'] || deps['vue']) return 'web-frontend';
      if (deps['express'] || deps['fastify'] || deps['koa'] || deps['hono']) return 'web-api';
      return 'node-library';
    } catch {
      return 'node-project';
    }
  }
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'requirements.txt'))) {
    return 'python-project';
  }
  return 'unknown';
}

function anyFileMatches(cwd: string, pattern: RegExp, depth = 3): boolean {
  function walk(dir: string, level: number): boolean {
    if (level > depth) return false;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules' || name === 'vendor') continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          if (walk(full, level + 1)) return true;
        } else if (st.isFile() && /\.(go|ts|js|py)$/.test(name)) {
          const text = readFileSync(full, 'utf-8');
          if (pattern.test(text)) return true;
        }
      } catch {
        /* skip */
      }
    }
    return false;
  }
  return walk(cwd, 0);
}

// ─── Prompt construction ────────────────────────────────────────────────────

const OUTPUT_SCHEMA_DESCRIPTION = `
Output STRICT JSON matching this TypeScript shape (no markdown fences, no commentary):

{
  "projectType": string,                  // e.g. "claude-code-plugin", "web-api", "cli", "library", "frontend"
  "features": Array<{
    "name": string,                       // 簡潔的繁體中文功能名稱，例如「登入功能」
    "importance": number,                 // 1-10，10 為最核心
    "purpose": string,                    // 一段繁體中文敘述，說明這個功能的用途與動機
    "users": string[],                    // 使用此功能的角色，繁體中文
    "inputs": Array<{ "name": string, "type"?: string, "required"?: boolean, "description": string }>,
    "outputs": Array<{ "name": string, "type"?: string, "required"?: boolean, "description": string }>,
    "examples": Array<{ "scenario": string, "steps": string[], "result": string }>,
    "constraints": string[],              // 邊界條件、限制、特殊規則
    "sources": string[]                   // 對應的程式碼路徑（檔案或以 / 結尾的目錄）
  }>
}
`.trim();

const TONE_GUIDANCE = `
重要寫作原則：
- 受眾是 PM／業務人員，不是工程師。請避免技術行話（不用提 HTTP、JSON、SDK、async 等詞彙）
- 用使用者視角描述功能，而不是程式視角。例如說「使用者輸入帳號密碼後系統驗證身分」，不是「呼叫 POST /login API」
- 範例情境要寫得像一個小故事，方便 PM 想像實際使用畫面
- examples 中的步驟與結果都標明「依程式碼推斷」，所以盡可能具體但保留可被推翻的空間
- 描述限制與邊界時，要寫成 PM 看得懂的業務規則（例如「同一帳號最多 3 個裝置同時登入」）
- 所有 name / purpose / 描述 / 範例使用繁體中文。sources 維持英文路徑。
- importance 的判定基準：是否是使用者每天會用到的核心流程；越高越重要
- 不要編造程式碼裡找不到的功能。若不確定，寧可省略
`.trim();

function buildFullModePrompt(
  cwd: string,
  projectTypeHint: string,
  skeletonText: string,
): string {
  return `你正在為一個程式專案撰寫「給非工程人員看的功能規格書」。專案結構與程式骨架已預先抽出於下方，你**不需要再去讀檔**，直接根據以下資訊推導所有對外功能。

專案路徑：${cwd}
專案類型推測：${projectTypeHint}

${skeletonText}

---

任務：
1. 判斷這個專案實際的類型（前端 / API / CLI / Plugin / Library / 其他）。
2. 從「對外提供的功能進入點」開始，反向推導出所有功能（features）。
   - Web app／API：以路由為單位
   - CLI：以指令為單位
   - Library／SDK：以 public exports 為單位
   - Plugin：以 commands / agents / skills 為單位
   - Frontend：以頁面 / 主要互動單元為單位
3. 每個 feature 都要包含：name / importance / purpose / users / inputs / outputs / examples / constraints / sources
4. features 陣列依 importance 由高到低排序
5. 預期 feature 數量：5～30（依專案規模）

${TONE_GUIDANCE}

${OUTPUT_SCHEMA_DESCRIPTION}`;
}

function buildIncrementalPrompt(
  cwd: string,
  projectTypeHint: string,
  existing: ParsedSpec,
  plan: ChangePlan,
  changedFileSnapshots: ChangedFileSnapshot[],
): string {
  const existingFeatureLines = existing.sections
    .map(
      (s) =>
        `- 「${s.feature.name}」 sources: [${s.feature.sources.join(', ')}]${
          plan.sectionsToRegenerate.find((r) => r.feature.name === s.feature.name)
            ? '  ← 需重新生成'
            : '  (保留不變)'
        }`,
    )
    .join('\n');

  const changedFilesList = plan.uncoveredChangedFiles.length
    ? plan.uncoveredChangedFiles.map((f) => `  - ${f}`).join('\n')
    : '  (無)';

  const fileSnapshotsBlock = changedFileSnapshots
    .map(
      (s) =>
        `### ${s.path}\n\`\`\`\n${s.content}\n\`\`\`${s.truncated ? '\n(內容已截斷)' : ''}`,
    )
    .join('\n\n');

  return `你正在更新一份「給非工程人員看的功能規格書」。先前的版本是 commit ${
    existing.meta?.lastFullRebuild ?? 'unknown'
  } 生成的，現在已經有新的程式碼變動，請根據以下資訊產出**新增 / 修改的章節**。

專案路徑：${cwd}
專案類型：${existing.meta?.projectType ?? projectTypeHint}

## 現有功能章節
${existingFeatureLines || '(尚無)'}

## 變動檔案中尚未對應到任何章節的檔案（可能是新功能）
${changedFilesList}

## 變動檔案的內容（節錄）
${fileSnapshotsBlock || '(無變動檔案內容)'}

---

任務：
1. 對於上方標示「需重新生成」的章節：用該章節原本的 name 與 sources，重新產出更新後的 FeatureSpec。
2. 對於「尚未對應到任何章節」的變動檔案，判斷是否代表新功能；若是，新增 FeatureSpec（name 必須與現有章節不重複）。
3. 不要重複輸出標記「保留不變」的章節。
4. 如果發現變動檔案僅是內部重構、與使用者面向功能無關，可以跳過不產出。
5. importance 的判定基準同初版：使用者使用頻率與重要性。

${TONE_GUIDANCE}

${OUTPUT_SCHEMA_DESCRIPTION}

注意：features 陣列只需要包含「需要新增 / 重新生成」的功能，未列出的章節會由系統自動沿用舊版本。`;
}

// ─── LLM call & response parsing ────────────────────────────────────────────

interface LLMOutput {
  projectType: string;
  features: Array<{
    name: string;
    importance: number;
    purpose: string;
    users: string[];
    inputs: SpecField[];
    outputs: SpecField[];
    examples: SpecExample[];
    constraints: string[];
    sources: string[];
  }>;
}

async function callLLM(
  client: GeminiClientInterface,
  prompt: string,
  primaryModel: string,
): Promise<LLMOutput> {
  progress(`Calling Gemini [${primaryModel}] (prompt: ${Math.round(prompt.length / 1024)}KB)...`);

  const generationConfig = {
    temperature: 0.1,
    topP: 0.95,
    responseMimeType: 'application/json',
    thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 },
  };

  let response: GenerateContentResponse;
  try {
    response = await client.generateContent({
      model: primaryModel,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    });
  } catch (err) {
    if (isRateLimitError(err)) {
      const waitSec = extractWaitTime(err);
      const retryModel = primaryModel !== CHEAP_MODEL ? CHEAP_MODEL : primaryModel;
      progress(`Rate limited on ${primaryModel}. Waiting ${waitSec}s, retrying with ${retryModel}...`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      response = await client.generateContent({
        model: retryModel,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { ...generationConfig, thinkingConfig: undefined },
      });
    } else {
      throw err;
    }
  }

  const raw = extractText(response);
  return parseLLMOutput(raw);
}

function parseLLMOutput(raw: string): LLMOutput {
  const cleaned = raw
    .replace(/^```json?\s*\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Gemini JSON output: ${(err as Error).message}\n\nRaw output:\n${raw.slice(0, 500)}`);
  }
  const obj = data as Partial<LLMOutput>;
  if (!obj.features || !Array.isArray(obj.features)) {
    throw new Error('Gemini output missing required "features" array');
  }
  return {
    projectType: typeof obj.projectType === 'string' ? obj.projectType : 'unknown',
    features: obj.features.map(normalizeFeature),
  };
}

function normalizeFeature(f: unknown): LLMOutput['features'][number] {
  const o = (f ?? {}) as Record<string, unknown>;
  return {
    name: String(o.name ?? '未命名功能'),
    importance: typeof o.importance === 'number' ? o.importance : 5,
    purpose: String(o.purpose ?? ''),
    users: Array.isArray(o.users) ? (o.users as unknown[]).map(String) : [],
    inputs: Array.isArray(o.inputs) ? (o.inputs as SpecField[]) : [],
    outputs: Array.isArray(o.outputs) ? (o.outputs as SpecField[]) : [],
    examples: Array.isArray(o.examples) ? (o.examples as SpecExample[]) : [],
    constraints: Array.isArray(o.constraints) ? (o.constraints as unknown[]).map(String) : [],
    sources: Array.isArray(o.sources) ? (o.sources as unknown[]).map(String) : [],
  };
}

// ─── Public entry point ─────────────────────────────────────────────────────

export async function runSpecPipeline(
  client: GeminiClientInterface,
  options: SpecPipelineOptions,
): Promise<SpecPipelineResult> {
  const { cwd, outputPath, primaryModel, dryRun = false, onConflict = 'abort' } = options;

  // ── Phase 0: env check ──
  progress('Phase 0: Environment check...');
  if (!isGitRepo(cwd)) {
    throw new Error(`Not a git repository: ${cwd}. /gemini:spec requires git for version anchoring.`);
  }
  const headHash = getHeadHash(cwd).slice(0, 7);
  progress(`  HEAD: ${headHash}`);

  // ── Phase 1: read existing & decide mode ──
  progress('Phase 1: Reading existing SPEC...');
  const existingText = existsSync(outputPath) ? readFileSync(outputPath, 'utf-8') : null;
  const existing: ParsedSpec | null = existingText ? parseSpecDocument(existingText) : null;

  let mode: 'full' | 'incremental' = 'full';
  let fromHash: string | null = null;

  if (!options.full && existing && existing.meta) {
    fromHash = options.fromHash ?? earliestSectionHash(existing) ?? existing.meta.lastFullRebuild;
    if (commitExists(fromHash, cwd)) {
      mode = 'incremental';
      progress(`  Mode: incremental (diff from ${fromHash.slice(0, 7)})`);
    } else {
      progress(`  Mode: full (anchor commit ${fromHash} not in history → fallback)`);
    }
  } else {
    progress(`  Mode: full ${options.full ? '(--full)' : '(no existing SPEC)'}`);
  }

  // ── Phase 2: project skeleton + change planning ──
  progress('Phase 2: Building project skeleton...');
  const skeleton = buildProjectSkeleton(cwd);
  const skeletonText = formatSkeletonForSpec(skeleton, cwd);

  let plan: ChangePlan | null = null;
  let changedFileSnapshots: ChangedFileSnapshot[] = [];

  if (mode === 'incremental' && existing && fromHash) {
    const changedFiles = diffChangedFiles(fromHash, cwd);
    progress(`  ${changedFiles.length} changed files since ${fromHash.slice(0, 7)}`);
    plan = planIncrementalChanges(existing, changedFiles, onConflict);

    progress(
      `  Plan: regenerate ${plan.sectionsToRegenerate.length}, keep ${plan.sectionsToKeep.length}, uncovered ${plan.uncoveredChangedFiles.length} files`,
    );

    if (plan.manualEditedSections.length > 0) {
      progress(`  ⚠️ Detected manual edits in: ${plan.manualEditedSections.map((s) => s.feature.name).join(', ')}`);
      if (onConflict === 'abort') {
        throw new ConflictError(plan.manualEditedSections.map((s) => s.feature.name));
      }
    }

    if (plan.sectionsToRegenerate.length === 0 && plan.uncoveredChangedFiles.length === 0) {
      progress('  No regeneration needed. SPEC is up to date.');
      return {
        mode,
        headHash,
        document: existingText ?? '',
        changedSections: [],
        newSections: [],
        skippedSections: plan.sectionsToKeep.map((s) => s.feature.name),
        manualEditedSections: plan.manualEditedSections.map((s) => s.feature.name),
        dryRun,
      };
    }

    const sampledFiles = new Set<string>();
    for (const s of plan.sectionsToRegenerate) {
      for (const f of changedFiles) {
        if (fileMatchesSources(f, s.feature.sources)) sampledFiles.add(f);
      }
    }
    for (const f of plan.uncoveredChangedFiles) sampledFiles.add(f);
    changedFileSnapshots = readChangedFiles(cwd, Array.from(sampledFiles));
  }

  if (dryRun) {
    progress('Dry run: skipping LLM call.');
    return {
      mode,
      headHash,
      document: existingText ?? '',
      changedSections: plan?.sectionsToRegenerate.map((s) => s.feature.name) ?? [],
      newSections: plan?.uncoveredChangedFiles ?? [],
      skippedSections: plan?.sectionsToKeep.map((s) => s.feature.name) ?? [],
      manualEditedSections: plan?.manualEditedSections.map((s) => s.feature.name) ?? [],
      dryRun: true,
    };
  }

  // ── Phase 3: LLM call ──
  progress('Phase 3: Calling Gemini...');
  const projectTypeHint = detectProjectTypeHint(cwd);
  const prompt =
    mode === 'full' || !existing || !plan
      ? buildFullModePrompt(cwd, projectTypeHint, skeletonText)
      : buildIncrementalPrompt(cwd, projectTypeHint, existing, plan, changedFileSnapshots);

  const llmOut = await callLLM(client, prompt, primaryModel);

  // ── Phase 4: assemble document ──
  progress('Phase 4: Assembling document...');
  const newSectionNames: string[] = [];
  const changedSectionNames: string[] = [];

  let finalSections: SpecSection[] = [];

  if (mode === 'full' || !existing || !plan) {
    finalSections = llmOut.features
      .map((f) => featureToSpec(f, headHash))
      .map((feature) => renderSection(feature));
    newSectionNames.push(...finalSections.map((s) => s.feature.name));
  } else {
    const updatedByName = new Map<string, SpecSection>();
    for (const f of llmOut.features) {
      const feature = featureToSpec(f, headHash);
      updatedByName.set(feature.name, renderSection(feature));
    }

    const survivingExisting: SpecSection[] = [];
    for (const old of existing.sections) {
      if (updatedByName.has(old.feature.name)) {
        changedSectionNames.push(old.feature.name);
        survivingExisting.push(updatedByName.get(old.feature.name)!);
        updatedByName.delete(old.feature.name);
      } else {
        survivingExisting.push(old);
      }
    }
    // Anything left in updatedByName is brand new.
    const brandNew = Array.from(updatedByName.values());
    newSectionNames.push(...brandNew.map((s) => s.feature.name));

    finalSections = [...survivingExisting, ...brandNew].sort(
      (a, b) => b.feature.importance - a.feature.importance,
    );
  }

  // Re-sort full mode by importance too (LLM was asked to do this; enforce).
  finalSections.sort((a, b) => b.feature.importance - a.feature.importance);

  const meta: SpecMeta = {
    projectType: llmOut.projectType || existing?.meta?.projectType || 'unknown',
    lastFullRebuild: mode === 'full' ? headHash : existing?.meta?.lastFullRebuild ?? headHash,
    generatedBy: primaryModel,
  };

  const document = renderSpecDocument(meta, finalSections);

  return {
    mode,
    headHash,
    document,
    changedSections: changedSectionNames,
    newSections: newSectionNames,
    skippedSections: plan?.sectionsToKeep.map((s) => s.feature.name) ?? [],
    manualEditedSections: plan?.manualEditedSections.map((s) => s.feature.name) ?? [],
    dryRun: false,
  };
}

function featureToSpec(f: LLMOutput['features'][number], headHash: string): FeatureSpec {
  return {
    name: f.name,
    importance: f.importance,
    purpose: f.purpose,
    users: f.users,
    inputs: f.inputs,
    outputs: f.outputs,
    examples: f.examples,
    constraints: f.constraints,
    sources: f.sources,
    lastUpdated: headHash,
  };
}

function earliestSectionHash(spec: ParsedSpec): string | null {
  if (spec.sections.length === 0) return null;
  // We can't compare git hashes lexicographically; just return the earliest
  // by appearance and let the caller resolve via `git merge-base` if needed.
  // For simplicity, fall back to the meta's last-full-rebuild if section
  // hashes look heterogeneous; otherwise use the first one.
  return spec.sections[0].feature.lastUpdated;
}

// ─── Skeleton formatter (compact for SPEC use) ──────────────────────────────

function formatSkeletonForSpec(
  skeleton: ReturnType<typeof buildProjectSkeleton>,
  cwd: string,
): string {
  const parts: string[] = [];
  parts.push('## 專案骨架');

  if (skeleton.readme) {
    parts.push('### README（專案意圖最權威的描述）');
    parts.push(skeleton.readme);
    parts.push('');
  }

  if (skeleton.entryPoints.length > 0) {
    parts.push('### 偵測到的進入點');
    for (const ep of skeleton.entryPoints) parts.push(`- ${ep}`);
    parts.push('');
  }

  // Highlight common "interface" directories that often map to features
  const interfaceDirs = skeleton.modules.filter((m) =>
    /(?:^|\/)(commands?|routes?|handlers?|controllers?|api|cli|pages|agents?|skills?)$/.test(m.path),
  );
  if (interfaceDirs.length > 0) {
    parts.push('### 對外介面層（可能對應功能）');
    for (const m of interfaceDirs) {
      parts.push(`#### ${m.path}`);
      for (const f of m.files) {
        const ex = f.exports.length > 0 ? ` → exports: ${f.exports.join(', ')}` : '';
        const doc = f.docComment ? `  // ${f.docComment}` : '';
        parts.push(`- ${f.path}${ex}${doc}`);
      }
    }
    parts.push('');
  }

  parts.push('### 模組結構');
  for (const m of skeleton.modules) {
    const role = m.inferredRole ? ` _${m.inferredRole}_` : '';
    parts.push(`#### ${m.path}${role}`);
    for (const f of m.files) {
      const ex = f.exports.length > 0 ? ` → ${f.exports.join(', ')}` : '';
      parts.push(`- ${f.path}${ex}`);
    }
  }

  // Plugin-level command / agent files (markdown), useful for plugins
  const pluginAuxDirs = ['commands', 'agents', 'skills', 'hooks'];
  for (const aux of pluginAuxDirs) {
    const auxDir = join(cwd, aux);
    if (!existsSync(auxDir)) continue;
    try {
      const files = readdirSync(auxDir).filter((n) => n.endsWith('.md'));
      if (files.length === 0) continue;
      parts.push('');
      parts.push(`### Plugin ${aux}/`);
      for (const f of files) {
        const rel = relative(cwd, join(auxDir, f));
        try {
          const head = readFileSync(join(auxDir, f), 'utf-8').slice(0, 600);
          parts.push(`#### ${rel}`);
          parts.push('```');
          parts.push(head);
          parts.push('```');
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }

  let text = parts.join('\n');
  if (text.length > MAX_SKELETON_CHARS) {
    text = text.slice(0, MAX_SKELETON_CHARS) + '\n\n...(truncated)';
  }
  return text;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class ConflictError extends Error {
  readonly editedSections: string[];
  constructor(editedSections: string[]) {
    super(
      `Detected manual edits in: ${editedSections.join(', ')}. ` +
        `Re-run with --on-conflict keep (skip these) or --on-conflict overwrite (regenerate them).`,
    );
    this.name = 'ConflictError';
    this.editedSections = editedSections;
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function extractText(response: GenerateContentResponse): string {
  const parts: string[] = [];
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.text && !part.thought) parts.push(part.text);
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
