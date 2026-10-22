/**
 * The QC worker running INSIDE the website's server process — for a host where a separate background
 * worker isn't wanted (e.g. one free Render web service). The same worker as `npm run qc:worker`
 * (runQcWorker): the analysis queue, stalled-run recovery and the hourly clean-up. The database queue
 * already makes it safe next to another worker (row locks, attempt-fenced updates), so a separate worker
 * can keep running while this one is tried.
 *
 * OFF unless QC_EMBEDDED_WORKER is "true" / "1" / "yes" / "on". It starts once per server process,
 * stops when the server is asked to stop (SIGTERM / SIGINT), and never brings the website down: if it
 * fails, the reason is logged (setting names only, no secrets) and the website keeps serving pages.
 */
import { runQcWorker } from "@/lib/analysis/worker-runner";

export const EMBEDDED_WORKER_SETTING = "QC_EMBEDDED_WORKER";

/** Is the in-website worker switched on? Off when the setting is missing or anything else. */
export function embeddedWorkerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ["true", "1", "yes", "on"].includes((env[EMBEDDED_WORKER_SETTING] ?? "").trim().toLowerCase());
}

export type EmbeddedWorker = { stop(): Promise<void>; done: Promise<void> };

type Deps = {
  run?: typeof runQcWorker;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Stops the worker on these process signals (tests pass none). */
  signals?: readonly NodeJS.Signals[];
};

// One per server process, even if the start-up hook runs more than once.
const KEY = Symbol.for("skybook-qc.embedded-worker");
type Holder = { [KEY]?: EmbeddedWorker };

/** Starts the in-website worker unless it's already running. Returns it (or the one already running). */
export function startEmbeddedWorker(deps: Deps = {}): EmbeddedWorker {
  const holder = globalThis as Holder;
  if (holder[KEY]) return holder[KEY];

  const run = deps.run ?? runQcWorker;
  const log = deps.log ?? ((line: string) => console.log(`[qc-worker] ${line}`));
  const error = deps.error ?? ((line: string) => console.error(`[qc-worker] ${line}`));
  const controller = new AbortController();
  const signals = deps.signals ?? (["SIGTERM", "SIGINT"] as const);
  const onSignal = () => controller.abort();
  for (const signal of signals) process.on(signal, onSignal);

  log("Starting the QC worker inside the website (QC_EMBEDDED_WORKER is on).");
  const done = Promise.resolve()
    // Stopped before it began (e.g. the server stopping straight away): don't start it at all.
    .then(() => (controller.signal.aborted ? undefined : run({ signal: controller.signal, log })))
    .then(
      () => log("QC worker stopped."),
      // Never rethrown: the website keeps running without the worker.
      (reason: unknown) => error(`QC worker stopped: ${reason instanceof Error ? reason.message : String(reason)}`)
    )
    .finally(() => {
      for (const signal of signals) process.off(signal, onSignal);
      delete holder[KEY];
    });

  const worker: EmbeddedWorker = {
    done,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
  holder[KEY] = worker;
  return worker;
}
