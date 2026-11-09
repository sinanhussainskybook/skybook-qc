import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db/database";
import type { ExpiredCursor } from "@/lib/db/qc-sessions";
import type { CleanupBatch } from "@/lib/qc/session";
import type { RunDeps } from "@/lib/analysis/pipeline";
import { abortableSleep, CLEANUP_EVERY_MS, IDLE_POLL_MS, runCleanupLoop, runWorker } from "@/lib/analysis/worker";

/**
 * The worker's hourly clean-up of expired QC sessions: when it runs, that a failure never stops it,
 * that batches never overlap, and that stopping the worker waits for a running batch.
 */

const HOUR = 60 * 60 * 1000;
const batch = (removed = 0, kept = 0, next: ExpiredCursor | null = null): CleanupBatch => ({ removed, kept, next });

/** A promise the test resolves by hand — a clean-up batch that is still running. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("the hourly clean-up loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once at start, then every hour — not before", async () => {
    expect(CLEANUP_EVERY_MS).toBe(HOUR);
    const purge = vi.fn(async () => batch());
    const controller = new AbortController();
    const loop = runCleanupLoop(purge, { signal: controller.signal });

    await vi.advanceTimersByTimeAsync(0);
    expect(purge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(purge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(purge).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(purge).toHaveBeenCalledTimes(4);

    controller.abort();
    await loop;
  });

  it("each batch continues where the last one stopped, and starts again from the oldest after the end", async () => {
    const cursor = { expiresAt: new Date("2026-10-01T00:00:00Z"), id: "s50" };
    const purge = vi
      .fn<(now: Date, after: ExpiredCursor | null) => Promise<CleanupBatch>>()
      .mockResolvedValueOnce(batch(0, 50, cursor)) // a full batch: more after it
      .mockResolvedValueOnce(batch(5, 0, null)) // the end: next time from the oldest
      .mockResolvedValue(batch());
    const controller = new AbortController();
    const loop = runCleanupLoop(purge, { signal: controller.signal });

    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(purge.mock.calls.map(([, after]) => after)).toEqual([null, cursor, null]);

    controller.abort();
    await loop;
  });

  it("logs what it deleted and kept, and nothing when there was nothing to do", async () => {
    const purge = vi.fn<() => Promise<CleanupBatch>>().mockResolvedValueOnce(batch(3, 2)).mockResolvedValue(batch());
    const log = vi.fn();
    const controller = new AbortController();
    const loop = runCleanupLoop(purge, { signal: controller.signal, log });

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "Clean-up: deleted 3 expired QC session(s).",
      "Clean-up: 2 expired QC session(s) kept — their files couldn't be deleted yet; tried again later.",
    ]);

    controller.abort();
    await loop;
  });

  it("a failure is logged (its kind only) and never stops the loop — the next hour tries again", async () => {
    const purge = vi
      .fn<() => Promise<CleanupBatch>>()
      .mockRejectedValueOnce(new TypeError("connection to postgres://secret@host failed"))
      .mockResolvedValue(batch(1));
    const log = vi.fn();
    const controller = new AbortController();
    const loop = runCleanupLoop(purge, { signal: controller.signal, log });

    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith("Clean-up failed: TypeError; trying again in an hour.");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith("Clean-up: deleted 1 expired QC session(s).");

    controller.abort();
    await loop;
  });

  it("never overlaps: a batch slower than an hour delays the next one instead of starting a second", async () => {
    const slow = deferred<CleanupBatch>();
    let running = 0;
    let mostAtOnce = 0;
    const purge = vi.fn(async () => {
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      try {
        return purge.mock.calls.length === 1 ? await slow.promise : batch();
      } finally {
        running--;
      }
    });
    const controller = new AbortController();
    const loop = runCleanupLoop(purge, { signal: controller.signal });

    await vi.advanceTimersByTimeAsync(3 * HOUR); // the first batch is still running
    expect(purge).toHaveBeenCalledTimes(1);

    slow.resolve(batch(1));
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(purge).toHaveBeenCalledTimes(1); // the hour counts from the end of the slow batch
    await vi.advanceTimersByTimeAsync(1);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(mostAtOnce).toBe(1);

    controller.abort();
    await loop;
  });

  it("stopping during the wait ends the loop at once", async () => {
    const purge = vi.fn(async () => batch());
    const controller = new AbortController();
    const loop = runCleanupLoop(purge, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    let ended = false;
    void loop.then(() => (ended = true));
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(true);
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it("stopping during a batch lets it finish, then ends — no new batch starts", async () => {
    const running = deferred<CleanupBatch>();
    const purge = vi.fn(() => running.promise);
    const controller = new AbortController();
    const loop = runCleanupLoop(purge, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);

    let ended = false;
    void loop.then(() => (ended = true));
    controller.abort();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(ended).toBe(false); // still deleting

    running.resolve(batch(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(true);
    expect(purge).toHaveBeenCalledTimes(1);
  });
});

describe("abortableSleep", () => {
  it("leaves no listener behind on the stop signal, however many waits there are", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    for (let i = 0; i < 5; i++) await abortableSleep(1, controller.signal);
    expect(add).toHaveBeenCalledTimes(5);
    expect(remove).toHaveBeenCalledTimes(5);
  });

  it("returns at once when already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await abortableSleep(HOUR, controller.signal);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("the worker runs the clean-up and waits for it on shutdown", () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "skybook-worker-test-"));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  /** A worker with an empty queue: every query finds nothing. */
  function idleDeps(): RunDeps {
    const db: Database = { exec: async () => {}, query: async () => [] as never[], transaction: (fn) => fn(db) };
    return {
      db,
      storage: {} as RunDeps["storage"],
      logoStorage: null,
      provider: { name: "mock" } as RunDeps["provider"],
      preparer: {} as RunDeps["preparer"],
      tempRoot,
    };
  }

  it("cleans up at start, and stopping the worker waits for a running batch before it returns", async () => {
    const running = deferred<CleanupBatch>();
    const purgeExpired = vi.fn(() => running.promise);
    const controller = new AbortController();
    const worker = runWorker(idleDeps(), { signal: controller.signal, idleMs: 5, purgeExpired });

    await vi.waitFor(() => expect(purgeExpired).toHaveBeenCalledTimes(1));
    let ended = false;
    void worker.then(() => (ended = true));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ended).toBe(false); // the batch is still deleting; the database connection must stay open

    running.resolve(batch(1));
    await worker;
    expect(ended).toBe(true);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
  });

  it("a failing clean-up doesn't stop the worker", async () => {
    const purgeExpired = vi.fn(async () => {
      throw new Error("Storage is down");
    });
    const log = vi.fn();
    const controller = new AbortController();
    const worker = runWorker(idleDeps(), { signal: controller.signal, idleMs: 5, purgeExpired, log, cleanupEveryMs: 20 });

    await vi.waitFor(() => expect(purgeExpired.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(log).toHaveBeenCalledWith("Clean-up failed: Error; trying again in an hour.");
    controller.abort();
    await worker;
  });
});

describe("picking up new checks", () => {
  it("an idle worker slot asks the queue for work every second (was every 2 s)", () => {
    expect(IDLE_POLL_MS).toBe(1_000);
  });
});
