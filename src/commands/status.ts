/**
 * status command — shows background job status.
 */

import {
  resolveStateDir, listJobs, readJobFile, readLogTail,
} from '../lib/state.js';

export interface StatusOptions {
  jobId?: string;
  all?: boolean;
  json?: boolean;
}

export async function runStatus(cwd: string, options: StatusOptions = {}): Promise<void> {
  const stateDir = resolveStateDir(cwd);
  const sessionId = undefined; // Always show all jobs regardless of session

  if (options.jobId) {
    // Show single job
    const job = readJobFile(stateDir, options.jobId);
    if (!job) {
      console.error(`Job not found: ${options.jobId}`);
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(job, null, 2));
      return;
    }

    const logTail = readLogTail(stateDir, job.id, 15);
    console.log(renderJobDetail(job, logTail));
    return;
  }

  // List all jobs
  const jobs = listJobs(stateDir, sessionId);

  if (jobs.length === 0) {
    console.log('No background jobs found.');
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }

  const rows = jobs.slice(0, 20).map(job => {
    const elapsed = formatElapsed(job);
    const summary = job.status === 'failed' && job.errorMessage
      ? job.errorMessage.slice(0, 50)
      : job.summary.slice(0, 50);
    const actions = buildActions(job);
    return {
      job: job.id,
      kind: job.kind,
      status: job.status,
      phase: job.phase,
      elapsed,
      summary,
      actions,
    };
  });

  console.log(renderBoxTable(
    ['Job', 'Kind', 'Status', 'Phase', 'Elapsed', 'Summary', 'Actions'],
    rows.map(r => [r.job, r.kind, r.status, r.phase, r.elapsed, r.summary, r.actions]),
  ));
}

function buildActions(job: import('../lib/state.js').JobRecord): string {
  const parts: string[] = [];
  if (job.status === 'running' || job.status === 'queued') {
    parts.push(`/gemini:status ${job.id}`);
  }
  if (job.status === 'completed') {
    parts.push(`/gemini:result ${job.id}`);
  }
  return parts.join(' ');
}

function renderBoxTable(headers: string[], rows: string[][]): string {
  const colCount = headers.length;
  // Calculate column widths
  const widths = headers.map((h, i) => {
    const cellWidths = rows.map(r => (r[i] ?? '').length);
    return Math.max(h.length, ...cellWidths);
  });

  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const line = (left: string, mid: string, right: string, fill: string) =>
    left + widths.map(w => fill.repeat(w + 2)).join(mid) + right;

  const top    = line('┌', '┬', '┐', '─');
  const sep    = line('├', '┼', '┤', '─');
  const bottom = line('└', '┴', '┘', '─');

  const formatRow = (cells: string[]) =>
    '│' + cells.map((c, i) => ` ${pad(c, widths[i])} `).join('│') + '│';

  const lines: string[] = [top, formatRow(headers), sep];
  for (let i = 0; i < rows.length; i++) {
    lines.push(formatRow(rows[i]));
    if (i < rows.length - 1) lines.push(sep);
  }
  lines.push(bottom);
  return lines.join('\n');
}

function formatElapsed(job: import('../lib/state.js').JobRecord): string {
  const start = job.startedAt ?? job.createdAt;
  const end = job.completedAt ?? new Date().toISOString();
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return '-';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h${remMin}m`;
}

function renderJobDetail(job: import('../lib/state.js').JobRecord, logTail: string[]): string {
  const sections: string[] = [];
  sections.push(`## Job: ${job.id}`);
  sections.push(`**Kind:** ${job.kind}`);
  sections.push(`**Status:** ${job.status}`);
  sections.push(`**Phase:** ${job.phase}`);
  sections.push(`**Summary:** ${job.summary}`);
  sections.push(`**Created:** ${job.createdAt}`);
  if (job.startedAt) sections.push(`**Started:** ${job.startedAt}`);
  if (job.completedAt) sections.push(`**Completed:** ${job.completedAt}`);
  if (job.errorMessage) sections.push(`**Error:** ${job.errorMessage}`);

  if (logTail.length > 0) {
    sections.push('\n### Recent Log');
    sections.push('```');
    sections.push(logTail.join('\n'));
    sections.push('```');
  }

  return sections.join('\n');
}
