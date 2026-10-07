/**
 * npm run qc:worker
 *
 * The content-analysis worker (Phase 6, D10). Runs next to the Next.js app
 * on the same persistent host and processes queued analysis runs from the
 * database. Stop it with Ctrl+C; a run it was working on is picked up again
 * after it goes stale.
 *
 * Settings come from the same places as the app (see .env.example):
 * DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
 * QC_ANALYSIS_PROVIDER (mock | local | google, plus that provider's settings).
 * With local, the health of the local models is checked and reported at start
 * (check names only); runs fail with a plain reason while it isn't healthy.
 * Nothing secret is printed.
 */
import { configuredProvider } from "@/lib/analysis/config";
import { createLimits, createProvider, createPreparer } from "@/lib/analysis/setup";
import { readLocalConfig } from "@/lib/analysis/local/config";
import { checkLocalHealth } from "@/lib/analysis/local/health";
import { DEFAULT_TEMP_ROOT, runWorker } from "@/lib/analysis/worker";
import { readStorageConfig } from "@/lib/storage/logo-storage";
import { getQcStorage } from "@/lib/storage/qc-storage";
import { createBucketClient } from "@/lib/storage/storage-api";
import { loadLocalEnv } from "./lib/env";
import { connect, wrapPostgres } from "@/lib/db/client";

async function main() {
  loadLocalEnv();
  const providerName = configuredProvider();
  if (!providerName) throw new Error("QC_ANALYSIS_PROVIDER is not set (mock, local or google).");
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set.");
  const storage = getQcStorage();
  if (!storage) throw new Error("Supabase Storage is not set up (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  const logoConfig = readStorageConfig();

  const sql = connect(url, { max: 4 });
  const controller = new AbortController();
  const stop = () => {
    if (!controller.signal.aborted) console.log("Stopping the worker…");
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const tempRoot = process.env.QC_WORKER_TEMP_DIR?.trim() || DEFAULT_TEMP_ROOT;
  const provider = createProvider(providerName, { tempRoot });
  const limits = createLimits(providerName);
  console.log(`QC analysis worker started — provider: ${provider.name}${provider.name === "mock" ? ` (${provider.label})` : ""}.`);
  if (providerName === "local") {
    const config = readLocalConfig();
    if (config.ok) {
      console.log(`Local profile: ${config.value.profile}${config.value.profile === "cpu" ? " (testing only — slow, not for designer use)" : ""}; ${limits.maxConcurrentRuns} run and ${limits.maxProviderCallsPerRun} model call at a time.`);
      const health = await checkLocalHealth(config.value);
      for (const c of health.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
      if (!health.ok) console.log("Local analysis is NOT ready: runs will fail with a plain reason until this is fixed (npm run qc:local:check).");
    }
  }
  try {
    await runWorker(
      {
        db: wrapPostgres(sql),
        storage,
        logoStorage: logoConfig ? createBucketClient(logoConfig, logoConfig.bucket) : null,
        provider,
        preparer: createPreparer(limits),
        tempRoot,
        limits,
      },
      { signal: controller.signal, log: (line) => console.log(line) }
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(`Worker stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
