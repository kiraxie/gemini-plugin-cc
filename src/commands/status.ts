/**
 * status command — shows background job status.
 */

import {
  resolveStateDir, listJobs, readJobFile, readLogTail, getSessionId,
} from '../lib/state.js';

export interface StatusOptions {
  jobId?: string;
  all?: boolean;
  json?: boolean;
}

export async function runStatus(cwd: string, options: StatusOptions = {}): Promise<void> {
  const stateDir = resolveStateDir(cwd);
  const sessionId = options.all ? undefined : getSessionId();

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

  const running = jobs.filter(j => j.status === 'queued' || j.status === 'running');
  const finished = jobs.filter(j => j.status === 'completed' || j.status === 'failed');

  const sections: string[] = [];

  if (running.length > 0) {
    sections.push('## Running');
    for (const job of running) {
      const logTail = readLogTail(stateDir, job.id, 3);
      const lastLine = logTail[logTail.length - 1] ?? '';
      sections.push(`- **${job.id}** \`${job.kind}\` — ${job.summary} [${job.status}] ${lastLine}`);
    }
  }

  if (finished.length > 0) {
    sections.push('## Recent');
    for (const job of finished.slice(0, 10)) {
      const icon = job.status === 'completed' ? '✓' : '✗';
      sections.push(`- ${icon} **${job.id}** \`${job.kind}\` — ${job.summary} [${job.status}]`);
    }
  }

  console.log(sections.join('\n\n'));
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
