/**
 * npm run qc:worker
 *
 * The content-analysis worker (Phase 6, D10). Runs next to the Next.js app
 * on the same persistent host and processes queued analysis runs from the
 * database. Stop it with Ctrl+C; a run it was working on is picked up again
 * after it goes stale. It also deletes expired QC sessions (D11) at start and
 * then every hour (runCleanupLoop in lib/analysis/worker.ts).
 *
 * Settings come from the same places as the app (see .env.example):
 * DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
 * QC_ANALYSIS_PROVIDER (mock | local | google, plus that provider's settings).
 * With local, the health of the local models is checked and reported at start
 * (check names only); runs fail with a plain reason while it isn't healthy.
 * Nothing secret is printed.
 */
import { runQcWorker } from "@/lib/analysis/worker-runner";
import { loadLocalEnv } from "./lib/env";

async function main() {
  loadLocalEnv();
  const controller = new AbortController();
  const stop = () => {
    if (!controller.signal.aborted) console.log("Stopping the worker…");
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // The same worker the website can run inside itself (QC_EMBEDDED_WORKER, lib/analysis/embedded-worker.ts).
  await runQcWorker({ signal: controller.signal, log: (line) => console.log(line) });
}

main().catch((error: unknown) => {
  console.error(`Worker stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
