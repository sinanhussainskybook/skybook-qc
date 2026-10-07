/**
 * Settings for the Gemini API provider (Google AI Studio). Read on the
 * server only (the worker and the smoke test), from the environment — the
 * existing external secrets file <home>/.skybook-qc/.env.local or the host's
 * settings. Never NEXT_PUBLIC_, never printed: errors name the setting only.
 *
 *   GEMINI_API_KEY    the Google AI Studio API key (sent in the
 *                     x-goog-api-key header — never in a URL)
 *   QC_GEMINI_MODEL   default gemini-3.8-flash (on the Gemini API free tier)
 *
 * The Gemini API has no data-region setting (unlike the Vertex provider's EU
 * endpoint), and on the free tier Google may use what is sent to improve its
 * products — see docs/GEMINI.md.
 */

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export type GeminiConfig = { apiKey: string; model: string; url: string };

export function readGeminiConfig(env: Record<string, string | undefined> = process.env): { ok: true; value: GeminiConfig } | { ok: false; error: string } {
  const apiKey = env.GEMINI_API_KEY?.trim() ?? "";
  if (!apiKey) return { ok: false, error: "GEMINI_API_KEY is missing." };
  // Newer Google AI Studio keys contain dots.
  if (!/^[A-Za-z0-9._-]{20,200}$/.test(apiKey)) return { ok: false, error: "GEMINI_API_KEY has an unexpected format." };
  const model = env.QC_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  if (!/^gemini-[a-z0-9.-]{1,60}$/.test(model)) return { ok: false, error: "QC_GEMINI_MODEL isn't a Gemini model id." };
  return { ok: true, value: { apiKey, model, url: `${GEMINI_API_BASE}/${model}:generateContent` } };
}
