import { configuredProvider } from "@/lib/analysis/config";
import { limitsFor } from "@/lib/analysis/limits";

/**
 * How much of each brief file the configured AI provider reads (its maxExtractionChars — the same
 * limits the worker uses; see setup.ts createLimits), for the web app: a light read of the settings,
 * without building the provider. Local AI on a CPU reads only the first 12,000 characters of a brief,
 * so the page warns about that and refuses longer typed briefs instead of letting them be cut short.
 */
export function briefReadingLimit(env: Record<string, string | undefined> = process.env): { chars: number; provider: string | null } {
  const provider = configuredProvider(env);
  // As createLimits: QC_LOCAL_PROFILE gpu, otherwise (unset or invalid) cpu.
  const profile = env.QC_LOCAL_PROFILE?.trim().toLowerCase() === "gpu" ? "gpu" : "cpu";
  return { chars: limitsFor(provider, profile).maxExtractionChars, provider };
}
