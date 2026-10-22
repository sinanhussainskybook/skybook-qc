import { configuredProvider } from "@/lib/analysis/config";
import { createLimits, createProvider, createPreparer } from "@/lib/analysis/setup";
import { readLocalConfig } from "@/lib/analysis/local/config";
import { checkLocalHealth } from "@/lib/analysis/local/health";
import { DEFAULT_TEMP_ROOT, runWorker } from "@/lib/analysis/worker";
import { connect, wrapPostgres } from "@/lib/db/client";
import { readStorageConfig } from "@/lib/storage/logo-storage";
import { getQcStorage } from "@/lib/storage/qc-storage";
import { createBucketClient } from "@/lib/storage/storage-api";

/**
 * The QC worker, set up from the environment and run until `signal` stops it: checks its settings,
 * opens its own database connection, runs the analysis queue and the hourly clean-up (runWorker), and
 * closes the connection when it stops. Shared by `npm run qc:worker` (its own process) and the worker
 * running inside the website (embedded-worker.ts). Settings come from the environment, already loaded
 * by the caller. Nothing secret is logged; a missing setting throws, naming the setting only.
 */
export async function runQcWorker(options: { signal: AbortSignal; log: (line: string) => void }): Promise<void> {
  const { signal, log } = options;
  const providerName = configuredProvider();
  if (!providerName) throw new Error("QC_ANALYSIS_PROVIDER is not set (mock, local or google).");
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set.");
  const storage = getQcStorage();
  if (!storage) throw new Error("Supabase Storage is not set up (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  const logoConfig = readStorageConfig();

  const sql = connect(url, { max: 4 });
  try {
    const tempRoot = process.env.QC_WORKER_TEMP_DIR?.trim() || DEFAULT_TEMP_ROOT;
    const provider = createProvider(providerName, { tempRoot });
    const limits = createLimits(providerName);
    log(`QC analysis worker started — provider: ${provider.name}${provider.name === "mock" ? ` (${provider.label})` : ""}.`);
    if (providerName === "local") {
      const config = readLocalConfig();
      if (config.ok) {
        log(`Local profile: ${config.value.profile}${config.value.profile === "cpu" ? " (testing only — slow, not for designer use)" : ""}; ${limits.maxConcurrentRuns} run and ${limits.maxProviderCallsPerRun} model call at a time.`);
        const health = await checkLocalHealth(config.value);
        for (const c of health.checks) log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
        if (!health.ok) log("Local analysis is NOT ready: runs will fail with a plain reason until this is fixed (npm run qc:local:check).");
      }
    }
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
      { signal, log }
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
