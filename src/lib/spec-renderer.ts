/**
 * SPEC.md serializer / parser.
 *
 * The SPEC document is round-trippable: each feature section carries an HTML
 * comment with metadata (sources, last-updated commit, content hash) so that
 * subsequent runs can:
 *   - figure out which sections need regeneration based on git diff,
 *   - detect manual edits via content hash mismatch.
 *
 * Format example:
 *
 *   <!-- gemini-spec:meta
 *   project-type: cli-plugin
 *   last-full-rebuild: a1b2c3d
 *   generated-by: gemini-3-flash-preview
 *   -->
 *
 *   # 專案功能規格書
 *
 *   ## 登入功能
 *   <!-- gemini-spec:section
 *   sources: src/auth/, src/api/auth.ts
 *   last-updated: a1b2c3d
 *   content-hash: 8f3e9a...
 *   -->
 *
 *   ### 用途
 *   ...
 */

import { createHash } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SpecMeta {
  projectType: string;
  lastFullRebuild: string;
  generatedBy: string;
}

export interface SpecField {
  name: string;
  type?: string;
  required?: boolean;
  description: string;
}

export interface SpecExample {
  scenario: string;
  steps: string[];
  result: string;
}

export interface FeatureSpec {
  name: string;
  importance: number;
  purpose: string;
  users: string[];
  inputs: SpecField[];
  outputs: SpecField[];
  examples: SpecExample[];
  constraints: string[];
  sources: string[];
  /** Commit hash this section was generated against. */
  lastUpdated: string;
}

export interface SpecSection {
  feature: FeatureSpec;
  /** Hash of the rendered body excluding the metadata comment. */
  contentHash: string;
  /** Full rendered text including heading + metadata + body. */
  rawText: string;
}

export interface ParsedSpec {
  meta: SpecMeta | null;
  preamble: string;
  sections: SpecSection[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const META_OPEN = '<!-- gemini-spec:meta';
const SECTION_OPEN = '<!-- gemini-spec:section';
const COMMENT_CLOSE = '-->';

const DEFAULT_PREAMBLE = `# 專案功能規格書

> 本文件由程式碼反向推導生成，請 PM／業務人員確認。
> 如發現與實際需求不符之處，可能代表程式邏輯有誤，請通知工程團隊。

`;

// ─── Hashing ─────────────────────────────────────────────────────────────────

export function hashContent(body: string): string {
  return createHash('sha256').update(body, 'utf-8').digest('hex').slice(0, 12);
}

// ─── Metadata comment helpers ────────────────────────────────────────────────

function buildMetaComment(meta: SpecMeta): string {
  return [
    META_OPEN,
    `project-type: ${meta.projectType}`,
    `last-full-rebuild: ${meta.lastFullRebuild}`,
    `generated-by: ${meta.generatedBy}`,
    COMMENT_CLOSE,
  ].join('\n');
}

function parseMetaComment(text: string): SpecMeta | null {
  const start = text.indexOf(META_OPEN);
  if (start === -1) return null;
  const end = text.indexOf(COMMENT_CLOSE, start);
  if (end === -1) return null;
  const body = text.slice(start + META_OPEN.length, end);
  const fields = parseKeyValueLines(body);
  if (!fields['project-type'] || !fields['last-full-rebuild']) return null;
  return {
    projectType: fields['project-type'],
    lastFullRebuild: fields['last-full-rebuild'],
    generatedBy: fields['generated-by'] ?? 'unknown',
  };
}

function buildSectionComment(feature: FeatureSpec, contentHash: string): string {
  return [
    SECTION_OPEN,
    `sources: ${feature.sources.join(', ')}`,
    `last-updated: ${feature.lastUpdated}`,
    `content-hash: ${contentHash}`,
    COMMENT_CLOSE,
  ].join('\n');
}

function parseSectionComment(comment: string): {
  sources: string[];
  lastUpdated: string;
  contentHash: string;
} | null {
  const start = comment.indexOf(SECTION_OPEN);
  if (start === -1) return null;
  const end = comment.indexOf(COMMENT_CLOSE, start);
  if (end === -1) return null;
  const body = comment.slice(start + SECTION_OPEN.length, end);
  const fields = parseKeyValueLines(body);
  if (!fields['sources'] || !fields['last-updated']) return null;
  return {
    sources: fields['sources']
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    lastUpdated: fields['last-updated'],
    contentHash: fields['content-hash'] ?? '',
  };
}

function parseKeyValueLines(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

// ─── Section body rendering ──────────────────────────────────────────────────

function renderSectionBody(feature: FeatureSpec): string {
  const parts: string[] = [];

  parts.push('### 用途');
  parts.push(feature.purpose.trim());
  parts.push('');

  if (feature.users.length > 0) {
    parts.push('### 使用者');
    for (const u of feature.users) parts.push(`- ${u}`);
    parts.push('');
  }

  if (feature.inputs.length > 0) {
    parts.push('### 輸入');
    for (const f of feature.inputs) parts.push(renderField(f));
    parts.push('');
  }

  if (feature.outputs.length > 0) {
    parts.push('### 輸出');
    for (const f of feature.outputs) parts.push(renderField(f));
    parts.push('');
  }

  if (feature.examples.length > 0) {
    parts.push('### 範例情境');
    parts.push('> ⚠️ 以下範例依程式碼推斷，請與 PM 確認');
    parts.push('');
    feature.examples.forEach((ex, i) => {
      parts.push(`**範例 ${i + 1}：${ex.scenario}**`);
      if (ex.steps.length > 0) {
        ex.steps.forEach((step, j) => parts.push(`${j + 1}. ${step}`));
      }
      if (ex.result) parts.push(`→ ${ex.result}`);
      parts.push('');
    });
  }

  if (feature.constraints.length > 0) {
    parts.push('### 限制與邊界');
    for (const c of feature.constraints) parts.push(`- ${c}`);
    parts.push('');
  }

  // Trim trailing blank lines
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.join('\n');
}

function renderField(f: SpecField): string {
  const flags: string[] = [];
  if (f.required) flags.push('必填');
  if (f.type) flags.push(f.type);
  const tag = flags.length > 0 ? ` (${flags.join(', ')})` : '';
  return `- **${f.name}**${tag}：${f.description}`;
}

export function renderSection(feature: FeatureSpec): SpecSection {
  const body = renderSectionBody(feature);
  const contentHash = hashContent(body);
  const heading = `## ${feature.name}`;
  const meta = buildSectionComment(feature, contentHash);
  const rawText = `${heading}\n${meta}\n\n${body}\n`;
  return { feature, contentHash, rawText };
}

// ─── Document assembly ───────────────────────────────────────────────────────

export function renderSpecDocument(meta: SpecMeta, sections: SpecSection[]): string {
  const parts: string[] = [];
  parts.push(buildMetaComment(meta));
  parts.push('');
  parts.push(DEFAULT_PREAMBLE.trimEnd());
  parts.push('');

  if (sections.length > 0) {
    parts.push('## 功能總覽');
    parts.push('');
    for (const s of sections) {
      parts.push(`- [${s.feature.name}](#${slugify(s.feature.name)})`);
    }
    parts.push('');
  }

  for (const s of sections) {
    parts.push(s.rawText.trimEnd());
    parts.push('');
  }

  return parts.join('\n').trimEnd() + '\n';
}

function stripTrailingHr(text: string): string {
  return text.replace(/\n\s*-{3,}\s*$/, '').trimEnd();
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// ─── Document parsing ───────────────────────────────────────────────────────

/**
 * Parse an existing SPEC.md back into structured form. Sections are recognised
 * by an `<!-- gemini-spec:section ... -->` comment immediately following an
 * `## ` heading. Sections without that comment are ignored (treated as part of
 * the preamble or other narrative content).
 */
export function parseSpecDocument(text: string): ParsedSpec {
  const meta = parseMetaComment(text);

  // Split the document at every `## ` heading at the start of a line.
  const headingRe = /^##\s+(.+?)\s*$/gm;
  const matches: Array<{ name: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(text)) !== null) {
    matches.push({ name: m[1].trim(), index: m.index });
  }

  if (matches.length === 0) {
    return { meta, preamble: text, sections: [] };
  }

  const preamble = text.slice(0, matches[0].index);
  const sections: SpecSection[] = [];

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const block = text.slice(start, end);
    const parsed = parseSectionBlock(matches[i].name, block);
    if (parsed) sections.push(parsed);
  }

  return { meta, preamble, sections };
}

function parseSectionBlock(name: string, block: string): SpecSection | null {
  // Skip the special "功能總覽" table-of-contents section.
  if (name === '功能總覽') return null;

  const sectionMeta = parseSectionComment(block);
  if (!sectionMeta) return null;

  // Find body: text after the closing `-->` of the section comment.
  const closeIdx = block.indexOf(COMMENT_CLOSE);
  if (closeIdx === -1) return null;
  const body = stripTrailingHr(
    block.slice(closeIdx + COMMENT_CLOSE.length).replace(/^\s*\n/, '').trimEnd(),
  );

  // We don't reconstruct the full FeatureSpec from the rendered body — only
  // metadata is recovered. The pipeline only needs sources + lastUpdated +
  // contentHash to drive incremental decisions; the rendered body is preserved
  // verbatim via rawText so untouched sections round-trip unchanged.
  const feature: FeatureSpec = {
    name,
    importance: 0,
    purpose: '',
    users: [],
    inputs: [],
    outputs: [],
    examples: [],
    constraints: [],
    sources: sectionMeta.sources,
    lastUpdated: sectionMeta.lastUpdated,
  };

  return {
    feature,
    contentHash: sectionMeta.contentHash,
    rawText: block.trimEnd() + '\n',
  };
}

// ─── Manual edit detection ──────────────────────────────────────────────────

/**
 * Recompute the body hash of an existing parsed section by rendering its
 * stored body the same way it was produced originally. Returns true if the
 * hash differs from the metadata, indicating the file was edited by hand.
 *
 * Since we don't reconstruct the FeatureSpec from rendered markdown, the
 * "expected" body must be re-extracted from rawText (the slice between the
 * closing `-->` and the next section).
 */
export function detectManualEdit(section: SpecSection): boolean {
  const closeIdx = section.rawText.indexOf(COMMENT_CLOSE);
  if (closeIdx === -1) return false;
  const body = stripTrailingHr(
    section.rawText.slice(closeIdx + COMMENT_CLOSE.length).replace(/^\s*\n/, '').trimEnd(),
  );
  const actual = hashContent(body);
  return section.contentHash !== '' && actual !== section.contentHash;
}
