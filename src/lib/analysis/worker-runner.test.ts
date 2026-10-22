import { afterEach, describe, expect, it, vi } from "vitest";
import { runQcWorker } from "@/lib/analysis/worker-runner";

/**
 * The worker's start-up, shared by `npm run qc:worker` and the worker inside the website: a missing
 * setting stops it with a message naming the setting only — never its value — before it connects.
 */
describe("runQcWorker settings", () => {
  afterEach(() => vi.unstubAllEnvs());
  const start = () => runQcWorker({ signal: new AbortController().signal, log: () => {} });

  it("needs QC_ANALYSIS_PROVIDER, DATABASE_URL and Storage, in that order", async () => {
    vi.stubEnv("QC_ANALYSIS_PROVIDER", "");
    await expect(start()).rejects.toThrow("QC_ANALYSIS_PROVIDER is not set");

    vi.stubEnv("QC_ANALYSIS_PROVIDER", "mock");
    vi.stubEnv("DATABASE_URL", "");
    await expect(start()).rejects.toThrow("DATABASE_URL is not set.");

    vi.stubEnv("DATABASE_URL", "postgres://user:secret-password@127.0.0.1:1/none");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const failure = await start().catch((e: Error) => e.message);
    expect(failure).toMatch(/Supabase Storage is not set up/);
    expect(failure).not.toContain("secret-password");
  });
});
