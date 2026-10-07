import type { ConfiguredProvider } from "@/lib/analysis/config";
import { ANALYSIS_LIMITS, limitsFor, type AnalysisLimits } from "@/lib/analysis/limits";
import { readLocalConfig } from "@/lib/analysis/local/config";
import { LocalProvider } from "@/lib/analysis/local/local-provider";
import { LocalMediaPreparer } from "@/lib/analysis/media/local";
import type { MediaPreparer } from "@/lib/analysis/media/types";
import { MockProvider } from "@/lib/analysis/mock-provider";
import type { AnalysisProvider } from "@/lib/analysis/provider";
import { readGoogleConfig } from "@/lib/analysis/google/config";
import { readGeminiConfig } from "@/lib/analysis/gemini/config";
import { GeminiProvider } from "@/lib/analysis/gemini/gemini-provider";
import { GoogleProvider, serviceAccountTokens } from "@/lib/analysis/google/google-provider";

/**
 * Builds the configured provider, its limits and the local media preparer for
 * the worker (never imported by the web app).
 */
export function createProvider(name: ConfiguredProvider, options: { tempRoot: string }): AnalysisProvider {
  if (name === "mock") {
    const delay = Number(process.env.QC_MOCK_DELAY_MS ?? 400);
    return new MockProvider({ delayMs: Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 10_000) : 400 });
  }
  if (name === "gemini") {
    const config = readGeminiConfig();
    if (!config.ok) throw new Error(config.error);
    return new GeminiProvider(config.value);
  }
  if (name === "local") {
    const config = readLocalConfig();
    if (!config.ok) throw new Error(config.error);
    return new LocalProvider(config.value, { tempRoot: options.tempRoot });
  }
  const config = readGoogleConfig();
  if (!config.ok) throw new Error(config.error);
  return new GoogleProvider(config.value, serviceAccountTokens(config.value.credentialsFile));
}

/** The limits for the configured provider (local: by QC_LOCAL_PROFILE). */
export function createLimits(name: ConfiguredProvider): AnalysisLimits {
  if (name !== "local") return limitsFor(name);
  const config = readLocalConfig();
  return limitsFor("local", config.ok ? config.value.profile : "cpu");
}

export function createPreparer(limits: AnalysisLimits = ANALYSIS_LIMITS): MediaPreparer {
  return new LocalMediaPreparer(limits);
}
