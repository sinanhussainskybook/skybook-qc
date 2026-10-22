import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddedWorkerEnabled, startEmbeddedWorker } from "@/lib/analysis/embedded-worker";

/**
 * The QC worker inside the website (QC_EMBEDDED_WORKER): off by default, starts once, stops cleanly,
 * and never takes the website down. The worker itself is replaced by a stand-in here.
 */

/** A stand-in worker that runs until it's told to stop. */
function fakeRun() {
  const calls: AbortSignal[] = [];
  const run = vi.fn(({ signal }: { signal: AbortSignal; log: (line: string) => void }) => {
    calls.push(signal);
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  return { run, calls };
}

const quiet = { log: () => {}, error: () => {}, signals: [] as const };
const started: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  while (started.length) await started.pop()!.stop();
});

describe("QC_EMBEDDED_WORKER", () => {
  it("is OFF by default and for anything but an explicit yes", () => {
    expect(embeddedWorkerEnabled({})).toBe(false);
    for (const value of ["", "0", "false", "no", "off", "maybe", " "]) expect([value, embeddedWorkerEnabled({ QC_EMBEDDED_WORKER: value })]).toEqual([value, false]);
    for (const value of ["true", "1", "yes", "on", " TRUE ", "On"]) expect([value, embeddedWorkerEnabled({ QC_EMBEDDED_WORKER: value })]).toEqual([value, true]);
  });
});

describe("startEmbeddedWorker", () => {
  it("starts the worker once per server process, however often the start-up hook runs", async () => {
    const { run } = fakeRun();
    const first = startEmbeddedWorker({ ...quiet, run });
    started.push(first);
    const second = startEmbeddedWorker({ ...quiet, run });
    expect(second).toBe(first);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("stop() asks the worker to stop and waits for it; it can be started again afterwards", async () => {
    const { run, calls } = fakeRun();
    const worker = startEmbeddedWorker({ ...quiet, run });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].aborted).toBe(false);
    await worker.stop();
    expect(calls[0].aborted).toBe(true);
    const again = startEmbeddedWorker({ ...quiet, run });
    started.push(again);
    expect(again).not.toBe(worker);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it("a server stop signal (SIGTERM) stops the worker; the listener is removed afterwards", async () => {
    const { run, calls } = fakeRun();
    const before = process.listenerCount("SIGTERM");
    const worker = startEmbeddedWorker({ log: () => {}, error: () => {}, run, signals: ["SIGTERM"] });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    process.emit("SIGTERM");
    await worker.done;
    expect(calls[0].aborted).toBe(true);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("a failing worker is logged and never thrown — the website keeps running", async () => {
    const error = vi.fn();
    const run = vi.fn(async () => {
      throw new Error("DATABASE_URL is not set.");
    });
    const worker = startEmbeddedWorker({ log: () => {}, error, run, signals: [] });
    await expect(worker.done).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("QC worker stopped: DATABASE_URL is not set.");
  });

  it("stopped before it began, the worker never starts", async () => {
    const { run } = fakeRun();
    await startEmbeddedWorker({ ...quiet, run }).stop();
    expect(run).not.toHaveBeenCalled();
  });

  it("logs that it started and that it stopped (no settings or secrets in the lines)", async () => {
    const log = vi.fn();
    const { run } = fakeRun();
    const worker = startEmbeddedWorker({ log, error: () => {}, run, signals: [] });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await worker.stop();
    expect(log.mock.calls.map(([line]) => line)).toEqual(["Starting the QC worker inside the website (QC_EMBEDDED_WORKER is on).", "QC worker stopped."]);
  });
});

describe("the Next.js start-up hook (src/instrumentation.ts)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/analysis/embedded-worker");
    vi.resetModules();
  });

  async function registerWith(env: Record<string, string | undefined>) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const start = vi.fn();
    vi.resetModules();
    vi.doMock("@/lib/analysis/embedded-worker", async (original) => ({ ...(await original<object>()), startEmbeddedWorker: start }));
    const { register } = await import("@/instrumentation");
    await register();
    return start;
  }

  it("does nothing when the setting is off or missing (the default)", async () => {
    expect(await registerWith({ NEXT_RUNTIME: "nodejs", QC_EMBEDDED_WORKER: undefined })).not.toHaveBeenCalled();
    expect(await registerWith({ NEXT_RUNTIME: "nodejs", QC_EMBEDDED_WORKER: "false" })).not.toHaveBeenCalled();
  });

  it("starts the worker on the Node.js server when the setting is on — never in the Edge runtime", async () => {
    expect(await registerWith({ NEXT_RUNTIME: "nodejs", QC_EMBEDDED_WORKER: "true" })).toHaveBeenCalledTimes(1);
    expect(await registerWith({ NEXT_RUNTIME: "edge", QC_EMBEDDED_WORKER: "true" })).not.toHaveBeenCalled();
  });
});
