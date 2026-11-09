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

/** A fixed seed: the same design asked twice gets the same answer as far as the model allows. */
export const GEMINI_SEED = 20261109;

/**
 * Generation settings for faster, more consistent answers, by model family. The model only transcribes
 * text and describes the design (prompts.ts) — no long reasoning is needed — so thinking is kept low:
 *   - Gemini 3 and later: thinking level LOW. The temperature stays at the model's default, as Google
 *     advises for Gemini 3 (a lower one can make these models loop or degrade).
 *   - Gemini 2.5 Flash / Flash-Lite: temperature 0 and thinking off (budget 0).
 *   - Gemini 2.5 Pro: temperature 0 and the smallest thinking budget it accepts (128; it can't be off).
 *   - Older models (no thinking): temperature 0.
 * Every model gets the fixed seed.
 */
export function geminiGenerationSettings(model: string): Record<string, unknown> {
  const family = /^gemini-(\d+)(?:\.(\d+))?/.exec(model);
  const major = family ? Number(family[1]) : 0;
  const minor = family?.[2] ? Number(family[2]) : 0;
  if (major >= 3) return { seed: GEMINI_SEED, thinkingConfig: { thinkingLevel: "LOW" } };
  if (major === 2 && minor >= 5) {
    return { seed: GEMINI_SEED, temperature: 0, thinkingConfig: { thinkingBudget: /-pro\b/.test(model) ? 128 : 0 } };
  }
  return { seed: GEMINI_SEED, temperature: 0 };
}
