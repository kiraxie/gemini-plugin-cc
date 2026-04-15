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
    report = JSON.parse(raw) as InvestigationReport;
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
