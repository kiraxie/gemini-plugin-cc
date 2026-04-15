/**
 * result command — retrieves background job output.
 */

import {
  resolveStateDir, listJobs, readJobFile, getSessionId,
} from '../lib/state.js';

export interface ResultOptions {
  jobId?: string;
  json?: boolean;
}

export async function runResult(cwd: string, options: ResultOptions = {}): Promise<void> {
  const stateDir = resolveStateDir(cwd);

  let jobId = options.jobId;

  // Default to latest finished job in current session
  if (!jobId) {
    const sessionId = getSessionId();
    const jobs = listJobs(stateDir, sessionId);
    const finished = jobs.find(j => j.status === 'completed' || j.status === 'failed');
    if (!finished) {
      console.error('No completed jobs found.');
      process.exit(1);
    }
    jobId = finished.id;
  }

  const job = readJobFile(stateDir, jobId);
  if (!job) {
    console.error(`Job not found: ${jobId}`);
    process.exit(1);
  }

  if (job.status === 'queued' || job.status === 'running') {
    console.error(`Job ${jobId} is still ${job.status}. Use /gemini:status to check progress.`);
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify({
      id: job.id,
      kind: job.kind,
      status: job.status,
      result: job.result,
      errorMessage: job.errorMessage,
    }, null, 2));
    return;
  }

  if (job.status === 'failed') {
    console.log(`## Job Failed: ${job.id}\n\n**Error:** ${job.errorMessage ?? 'Unknown error'}`);
    return;
  }

  // Output the result (already rendered as Markdown by the worker)
  if (job.result) {
    console.log(job.result);
  } else {
    console.log('Job completed but produced no output.');
  }
}
