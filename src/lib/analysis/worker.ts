import { mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claimNextRun, recoverStaleRuns } from "@/lib/db/analysis-runs";
import { limitsOf, processRun, type RunDeps } from "@/lib/analysis/pipeline";

/**
 * The analysis worker (D10): a separate process from the same codebase
 * (`npm run qc:worker`). PostgreSQL is the queue — no Redis or BullMQ.
 *   - at most 2 runs at a time (each run makes at most 3 provider calls);
 *     the local provider: 1 run and 1 model call at a time (limits.ts);
 *   - every 30 s, runs whose worker stopped sending heartbeats are queued
 *     again (or failed once their attempts are used up);
 *   - temporary folders left by a crash are swept when the worker starts.
 */

export const DEFAULT_TEMP_ROOT = path.join(os.tmpdir(), "skybook-qc-runs");

/** Removes every leftover per-run folder (only inside our own temp root). */
export async function sweepTempRoot(tempRoot: string): Promise<number> {
  await mkdir(tempRoot, { recursive: true });
  const entries = await readdir(tempRoot);
  await Promise.all(entries.map((e) => rm(path.join(tempRoot, e), { recursive: true, force: true })));
  return entries.length;
}

/** Claims and processes one queued run for this worker's provider. Returns false when there is none. */
export async function workOnce(deps: RunDeps): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  const run = await claimNextRun(deps.db, now(), deps.provider.name);
  if (!run) return false;
  await processRun(deps, run);
  return true;
}

export async function recoverStale(deps: Pick<RunDeps, "db" | "now" | "limits">): Promise<{ requeued: number; failed: number }> {
  const now = deps.now ? deps.now() : new Date();
  const limits = limitsOf(deps);
  return recoverStaleRuns(deps.db, now, new Date(now.getTime() - limits.staleAfterMs), limits.maxRunAttempts);
}

export async function runWorker(deps: RunDeps, options: { signal: AbortSignal; idleMs?: number; log?: (line: string) => void }): Promise<void> {
  const log = options.log ?? (() => {});
  const idle = options.idleMs ?? 2_000;
  const swept = await sweepTempRoot(deps.tempRoot);
  if (swept) log(`Removed ${swept} leftover temporary folder(s).`);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });

  const recovery = (async () => {
    while (!options.signal.aborted) {
      const { requeued, failed } = await recoverStale(deps).catch(() => ({ requeued: 0, failed: 0 }));
      if (requeued || failed) log(`Recovered stale runs: ${requeued} queued again, ${failed} failed.`);
      await sleep(30_000);
    }
  })();

  const slot = async (n: number) => {
    while (!options.signal.aborted) {
      let worked = false;
      try {
        worked = await workOnce(deps);
      } catch (error) {
        log(`Slot ${n}: ${error instanceof Error ? error.name : "error"} while processing a run.`);
      }
      if (!worked) await sleep(idle);
    }
  };

  await Promise.all([recovery, ...Array.from({ length: limitsOf(deps).maxConcurrentRuns }, (_, i) => slot(i + 1))]);
}
