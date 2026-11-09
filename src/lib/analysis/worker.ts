import { mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claimNextRun, recoverStaleRuns } from "@/lib/db/analysis-runs";
import { limitsOf, processRun, type RunDeps } from "@/lib/analysis/pipeline";
import type { ExpiredCursor } from "@/lib/db/qc-sessions";
import { purgeExpiredBatch, type CleanupBatch } from "@/lib/qc/session";

/**
 * The analysis worker (D10): a separate process from the same codebase
 * (`npm run qc:worker`). PostgreSQL is the queue — no Redis or BullMQ.
 *   - at most 2 runs at a time (each run makes at most 3 provider calls);
 *     the local provider: 1 run and 1 model call at a time (limits.ts);
 *   - every 30 s, runs whose worker stopped sending heartbeats are queued
 *     again (or failed once their attempts are used up);
 *   - temporary folders left by a crash are swept when the worker starts;
 *   - expired QC sessions (24 h after their last change, D11) are deleted at
 *     start and then every hour, one batch at a time (runCleanupLoop).
 */

export const DEFAULT_TEMP_ROOT = path.join(os.tmpdir(), "skybook-qc-runs");

/**
 * How long an idle worker slot waits before asking the queue for work again — the most a new check waits
 * to be picked up (one small database query per slot per wait). Was 2 s.
 */
export const IDLE_POLL_MS = 1_000;

/** How often the worker deletes expired QC sessions. */
export const CLEANUP_EVERY_MS = 60 * 60 * 1000;

/** Waits `ms`, or less if the worker is stopped. Leaves no listener behind on the signal. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Deletes expired QC sessions now and then every `everyMs` until the worker stops. One batch at a time
 * — a batch always finishes before the wait starts, so batches never overlap. Each batch continues where
 * the previous one stopped (purgeExpiredBatch), so sessions that keep failing can't block newer ones.
 * A failure is logged (its kind only) and the next hour tries again; it never stops the worker. On stop,
 * a running batch is finished (deletion is files first, so stopping in between is safe too).
 */
export async function runCleanupLoop(
  purge: (now: Date, after: ExpiredCursor | null) => Promise<CleanupBatch>,
  options: { signal: AbortSignal; everyMs?: number; now?: () => Date; log?: (line: string) => void }
): Promise<void> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  let after: ExpiredCursor | null = null;
  while (!options.signal.aborted) {
    try {
      const batch = await purge(now(), after);
      after = batch.next;
      if (batch.removed) log(`Clean-up: deleted ${batch.removed} expired QC session(s).`);
      if (batch.kept) log(`Clean-up: ${batch.kept} expired QC session(s) kept — their files couldn't be deleted yet; tried again later.`);
    } catch (error) {
      log(`Clean-up failed: ${error instanceof Error ? error.name : "error"}; trying again in an hour.`);
    }
    await abortableSleep(options.everyMs ?? CLEANUP_EVERY_MS, options.signal);
  }
}

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

export async function runWorker(
  deps: RunDeps,
  options: {
    signal: AbortSignal;
    idleMs?: number;
    log?: (line: string) => void;
    cleanupEveryMs?: number;
    /** The clean-up batch (tests); defaults to purgeExpiredBatch on the worker's database and Storage. */
    purgeExpired?: (now: Date, after: ExpiredCursor | null) => Promise<CleanupBatch>;
  }
): Promise<void> {
  const log = options.log ?? (() => {});
  const idle = options.idleMs ?? IDLE_POLL_MS;
  const swept = await sweepTempRoot(deps.tempRoot);
  if (swept) log(`Removed ${swept} leftover temporary folder(s).`);

  const sleep = (ms: number) => abortableSleep(ms, options.signal);

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

  const cleanup = runCleanupLoop(
    options.purgeExpired ?? ((now, after) => purgeExpiredBatch(deps.db, deps.storage, now, after)),
    { signal: options.signal, everyMs: options.cleanupEveryMs, now: deps.now, log }
  );

  await Promise.all([recovery, cleanup, ...Array.from({ length: limitsOf(deps).maxConcurrentRuns }, (_, i) => slot(i + 1))]);
}
