/**
 * Which analysis provider this server uses (Phase 6). Read from the
 * environment (the existing external secrets file or the host's settings):
 *
 *   QC_ANALYSIS_PROVIDER = mock | gemini | local | google   (unset → analysis not set up)
 *
 * gemini = the Gemini API (Google AI Studio, GEMINI_API_KEY) — one call per
 *          design; settings in lib/analysis/gemini/config.ts.
 *
 * local  = PaddleOCR + Ollama (loopback only) + whisper.cpp on this server;
 *          its settings are read by lib/analysis/local/config.ts.
 * google = optional / future cloud provider.
 *
 * The Google settings themselves are read by lib/analysis/google/config.ts
 * on the server only. Nothing here is ever sent to the browser.
 */
export type ConfiguredProvider = "mock" | "gemini" | "local" | "google";

export function configuredProvider(env: Record<string, string | undefined> = process.env): ConfiguredProvider | null {
  const value = env.QC_ANALYSIS_PROVIDER?.trim().toLowerCase();
  return value === "mock" || value === "gemini" || value === "local" || value === "google" ? value : null;
}
