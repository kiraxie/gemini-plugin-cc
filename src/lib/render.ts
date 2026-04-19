/**
 * Renderers that convert structured JSON reports into Markdown.
 */

// ─── Investigation Report ────────────────────────────────────────────────────

interface RelevantLocation {
  FilePath?: string;
  Reasoning?: string;
  KeySymbols?: string[];
}

interface InvestigationReport {
  SummaryOfFindings?: string;
  ExplorationTrace?: string[];
  RelevantLocations?: RelevantLocation[];
}

/**
 * Renders an investigation report JSON into readable Markdown.
 * Falls back to the raw string if parsing fails.
 */
export function renderInvestigationReport(raw: string): string {
  let report: InvestigationReport;
  try {
    const cleaned = raw.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    report = JSON.parse(cleaned) as InvestigationReport;
  } catch {
    // Not valid JSON — return as-is (model may have returned plain text)
    return raw;
  }

  const sections: string[] = [];

  sections.push('# Codebase Investigation Report');

  if (report.SummaryOfFindings) {
    sections.push('## Summary of Findings');
    sections.push(report.SummaryOfFindings);
  }

  if (report.RelevantLocations && report.RelevantLocations.length > 0) {
    sections.push('## Relevant Locations');
    for (const loc of report.RelevantLocations) {
      const symbols = loc.KeySymbols?.length
        ? loc.KeySymbols.map(s => `\`${s}\``).join(', ')
        : '';
      sections.push(`### \`${loc.FilePath ?? 'unknown'}\``);
      if (loc.Reasoning) sections.push(loc.Reasoning);
      if (symbols) sections.push(`**Key symbols:** ${symbols}`);
    }
  }

  if (report.ExplorationTrace && report.ExplorationTrace.length > 0) {
    sections.push('## Exploration Trace');
    for (const step of report.ExplorationTrace) {
      sections.push(`- ${step}`);
    }
  }

  return sections.join('\n\n');
}

// ─── Opinion Report ──────────────────────────────────────────────────────────

interface Alternative {
  approach?: string;
  prosAndCons?: string;
}

interface OpinionReport {
  Opinion?: string;
  Reasoning?: string;
  Alternatives?: Alternative[];
  References?: string[];
}

/**
 * Renders an opinion report JSON into readable Markdown.
 */
export function renderOpinionReport(raw: string): string {
  let report: OpinionReport;
  try {
    const cleaned = raw.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    report = JSON.parse(cleaned) as OpinionReport;
  } catch {
    return raw;
  }

  const sections: string[] = [];

  sections.push('# Gemini Opinion');

  if (report.Opinion) {
    sections.push(report.Opinion);
  }

  if (report.Reasoning) {
    sections.push('## Reasoning');
    sections.push(report.Reasoning);
  }

  if (report.Alternatives && report.Alternatives.length > 0) {
    sections.push('## Alternatives Considered');
    for (const alt of report.Alternatives) {
      sections.push(`### ${alt.approach ?? 'Unknown'}`);
      if (alt.prosAndCons) sections.push(alt.prosAndCons);
    }
  }

  if (report.References && report.References.length > 0) {
    sections.push('## References');
    sections.push(report.References.map(r => `- \`${r}\``).join('\n'));
  }

  return sections.join('\n\n');
}

// ─── Analysis Report ─────────────────────────────────────────────────────────

interface Dependency {
  name?: string;
  purpose?: string;
}

interface ModuleEntry {
  path?: string;
  role?: string;
  keyFiles?: string[];
  keyExports?: string[];
}

interface Convention {
  pattern?: string;
  description?: string;
  examples?: string[];
}

interface EntryPoint {
  path?: string;
  description?: string;
}

interface AnalysisReport {
  ProjectSummary?: string;
  TechStack?: {
    language?: string;
    framework?: string;
    keyDependencies?: Dependency[];
  };
  ModuleMap?: ModuleEntry[];
  Conventions?: Convention[];
  EntryPoints?: EntryPoint[];
  ArchitectureNotes?: string;
}

/**
 * Renders an analysis report into a Markdown context document.
 *
 * The pipeline now asks Gemini for Markdown directly, so in the happy path we
 * strip any accidental ```markdown fences and return as-is. The legacy JSON
 * schema path is still handled for backward compatibility (opinion/investigate
 * agents, or older cached outputs).
 */
export function renderAnalysisReport(raw: string): string {
  // Strip only an outer ```markdown wrapper at the very start/end of the whole
  // string. No `m` flag — we must NOT strip fenced blocks inside the document
  // (e.g. an ASCII data-flow diagram wrapped in ```text).
  const stripped = raw
    .replace(/^```(?:markdown|md)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  // If it starts with a markdown heading, treat as markdown.
  if (/^#\s/.test(stripped)) {
    return stripped;
  }

  // Fall back to the legacy JSON schema.
  let report: AnalysisReport;
  try {
    const cleaned = raw.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    report = JSON.parse(cleaned) as AnalysisReport;
  } catch {
    return raw;
  }

  const sections: string[] = [];

  sections.push('# Project Context');

  if (report.ProjectSummary) {
    sections.push('## Overview');
    sections.push(report.ProjectSummary);
  }

  if (report.TechStack) {
    const ts = report.TechStack;
    const parts: string[] = [];
    if (ts.language) parts.push(`**Language:** ${ts.language}`);
    if (ts.framework) parts.push(`**Framework:** ${ts.framework}`);
    if (parts.length > 0) {
      sections.push('## Tech Stack');
      sections.push(parts.join('\n'));
    }
    if (ts.keyDependencies && ts.keyDependencies.length > 0) {
      const deps = ts.keyDependencies
        .map(d => `- **${d.name ?? '?'}** — ${d.purpose ?? ''}`)
        .join('\n');
      sections.push('### Key Dependencies');
      sections.push(deps);
    }
  }

  if (report.ModuleMap && report.ModuleMap.length > 0) {
    sections.push('## Module Map');
    for (const mod of report.ModuleMap) {
      sections.push(`### \`${mod.path ?? 'unknown'}\``);
      if (mod.role) sections.push(mod.role);
      if (mod.keyFiles?.length) {
        sections.push('**Key files:** ' + mod.keyFiles.map(f => `\`${f}\``).join(', '));
      }
      if (mod.keyExports?.length) {
        sections.push('**Key exports:** ' + mod.keyExports.map(s => `\`${s}\``).join(', '));
      }
    }
  }

  if (report.Conventions && report.Conventions.length > 0) {
    sections.push('## Conventions & Patterns');
    for (const conv of report.Conventions) {
      sections.push(`### ${conv.pattern ?? 'Unknown Pattern'}`);
      if (conv.description) sections.push(conv.description);
      if (conv.examples?.length) {
        sections.push('**Examples:** ' + conv.examples.map(e => `\`${e}\``).join(', '));
      }
    }
  }

  if (report.EntryPoints && report.EntryPoints.length > 0) {
    sections.push('## Entry Points');
    const entries = report.EntryPoints
      .map(e => `- \`${e.path ?? '?'}\` — ${e.description ?? ''}`)
      .join('\n');
    sections.push(entries);
  }

  if (report.ArchitectureNotes) {
    sections.push('## Architecture Notes');
    sections.push(report.ArchitectureNotes);
  }

  return sections.join('\n\n');
}
