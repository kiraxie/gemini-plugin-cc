/**
 * Background execution support.
 *
 * Spawns a detached worker process and returns immediately with a job ID.
 * The worker runs the same command (investigate/analyze/opinion) and
 * writes results to the job state directory.
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import {
  resolveStateDir, generateJobId, createJob, updateJob,
  writeJobFile, appendLog, getSessionId, jobLogPath,
  type JobRecord, type JobRequest,
} from '../lib/state.js';
import { createAuth } from '../lib/gemini-auth.js';
import { GeminiClient } from '../lib/client.js';
import { createInvestigatorConfig } from '../agents/codebase-investigator.js';
import { createAnalyzerConfig } from '../agents/codebase-analyzer.js';
import { createOpinionConfig } from '../agents/opinion-advisor.js';
import { runAgentLoop } from '../agents/agent-loop.js';
import { renderInvestigationReport, renderAnalysisReport, renderOpinionReport } from '../lib/render.js';

/**
 * Enqueue a command for background execution.
 * Spawns a detached child process and returns the job ID immediately.
 */
export function enqueueBackground(
  command: string,
  args: string[],
  flags: Record<string, string | boolean>,
  cwd: string,
): string {
  const stateDir = resolveStateDir(cwd);
  const jobId = generateJobId();

  const summary = args.join(' ').slice(0, 80) || command;
  const job: JobRecord = {
    id: jobId,
    kind: command,
    title: `Gemini ${command}`,
    summary,
    status: 'queued',
    phase: 'queued',
    cwd,
    createdAt: new Date().toISOString(),
    sessionId: getSessionId(),
    request: { command, args, flags, cwd },
  };

  createJob(stateDir, job);
  appendLog(stateDir, jobId, `Queued for background execution: ${command} "${summary}"`);

  // Spawn detached worker
  // The worker re-invokes gemini-companion.cjs with the internal `_worker` command
  const scriptPath = getScriptPath();
  const child = spawn(process.execPath, [scriptPath, '_worker', '--job-id', jobId, '--cwd', cwd], {
    cwd,
    env: { ...process.env, GEMINI_COMPANION_SESSION_ID: getSessionId() ?? '' },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  updateJob(stateDir, jobId, { pid: child.pid ?? null });

  return jobId;
}

function getScriptPath(): string {
  return __filename;
}

/**
 * Worker entry point — runs the actual command and writes results to state.
 * Called internally by the detached process.
 */
export async function runWorker(jobId: string, cwd: string): Promise<void> {
  const stateDir = resolveStateDir(cwd);
  const job = await import('../lib/state.js').then(m => m.readJobFile(stateDir, jobId));

  if (!job) {
    console.error(`Worker: Job not found: ${jobId}`);
    process.exit(1);
  }

  const { command, args, flags } = job.request;

  updateJob(stateDir, jobId, {
    status: 'running',
    phase: 'starting',
    startedAt: new Date().toISOString(),
  });
  appendLog(stateDir, jobId, 'Worker started.');

  // Redirect stderr progress to log file
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    if (text.trim()) {
      appendLog(stateDir, jobId, text.trim());
    }
    return true;
  }) as typeof process.stderr.write;

  try {
    const auth = await createAuth();
    const forceStandard = flags['standard'] === true;
    const client = new GeminiClient(auth, forceStandard);
    const useCodeAssist = !forceStandard && !!(auth.oauthClient && !client.isDegraded);
    const scopePath = typeof flags['path'] === 'string' ? flags['path'] : undefined;
    const effectiveCwd = scopePath ? resolve(cwd, scopePath) : cwd;

    let result: { result: string; terminateReason: string };
    let rendered: string;

    switch (command) {
      case 'investigate': {
        const objective = args.join(' ');
        const config = createInvestigatorConfig(objective, effectiveCwd, useCodeAssist);
        result = await runAgentLoop(client, config);
        rendered = renderInvestigationReport(result.result);
        break;
      }
      case 'analyze': {
        const focus = typeof flags['focus'] === 'string' ? flags['focus'] : undefined;
        const config = createAnalyzerConfig(effectiveCwd, useCodeAssist, focus);
        result = await runAgentLoop(client, config);
        rendered = renderAnalysisReport(result.result);
        break;
      }
      case 'opinion': {
        const question = args.join(' ');
        const config = createOpinionConfig(question, effectiveCwd, useCodeAssist);
        result = await runAgentLoop(client, config);
        rendered = renderOpinionReport(result.result);
        break;
      }
      default:
        throw new Error(`Unknown command for worker: ${command}`);
    }

    // Write rendered output to file if --write was specified
    const writePath = typeof flags['write'] === 'string' ? flags['write'] : undefined;
    if (writePath) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const outPath = resolve(cwd, writePath);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, rendered, 'utf-8');
      appendLog(stateDir, jobId, `Report saved to: ${outPath}`);
    }

    updateJob(stateDir, jobId, {
      status: 'completed',
      phase: 'done',
      completedAt: new Date().toISOString(),
      result: rendered,
    });
    appendLog(stateDir, jobId, `Completed (${result.terminateReason}).`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateJob(stateDir, jobId, {
      status: 'failed',
      phase: 'failed',
      completedAt: new Date().toISOString(),
      errorMessage: message,
    });
    appendLog(stateDir, jobId, `Failed: ${message}`);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
}
