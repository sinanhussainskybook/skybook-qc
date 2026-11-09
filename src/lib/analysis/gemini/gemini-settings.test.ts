import { describe, expect, it, vi } from "vitest";
import { GEMINI_SEED, geminiGenerationSettings, readGeminiConfig } from "@/lib/analysis/gemini/config";
import { GeminiProvider, isDailyQuota } from "@/lib/analysis/gemini/gemini-provider";
import { callProvider, DESIGNER_MESSAGES, designerMessage } from "@/lib/analysis/call";
import { ProviderError, type DesignContext, type PreparedImage } from "@/lib/analysis/provider";

/** Stage 1 (speed): Gemini generation settings, and no pointless retries once the day's quota is used up. */

const KEY = "AIzaTESTKEY_not_real_0123456789abcdef";
const configFor = (model?: string) => {
  const c = readGeminiConfig({ GEMINI_API_KEY: KEY, QC_GEMINI_MODEL: model });
  if (!c.ok) throw new Error(c.error);
  return c.value;
};
const image: PreparedImage = { key: "f1", mime: "image/png", bytes: new Uint8Array([1, 2, 3]), width: 1000, height: 500 };
const context: DesignContext = { companyName: "Acme", requirements: [], goldenRules: [], brandColours: [], brandFonts: [], approvedTerms: [], bannedTerms: [] };
const answer = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }), { status: 200 });
const google = (status: number, message: string) => new Response(JSON.stringify({ error: { code: status, message, status: "X" } }), { status });

describe("Gemini generation settings", () => {
  it("Gemini 3 and later (the default model): low thinking, the model's default temperature, a fixed seed", () => {
    for (const model of ["gemini-3.8-flash", "gemini-3-pro-preview", "gemini-4-flash"]) {
      expect(geminiGenerationSettings(model)).toEqual({ seed: GEMINI_SEED, thinkingConfig: { thinkingLevel: "LOW" } });
    }
  });

  it("Gemini 2.5: temperature 0; thinking off for Flash / Flash-Lite, the smallest budget for Pro", () => {
    expect(geminiGenerationSettings("gemini-2.5-flash")).toEqual({ seed: GEMINI_SEED, temperature: 0, thinkingConfig: { thinkingBudget: 0 } });
    expect(geminiGenerationSettings("gemini-2.5-flash-lite")).toEqual({ seed: GEMINI_SEED, temperature: 0, thinkingConfig: { thinkingBudget: 0 } });
    expect(geminiGenerationSettings("gemini-2.5-pro")).toEqual({ seed: GEMINI_SEED, temperature: 0, thinkingConfig: { thinkingBudget: 128 } });
  });

  it("older models without thinking: temperature 0 and the seed only", () => {
    expect(geminiGenerationSettings("gemini-2.0-flash")).toEqual({ seed: GEMINI_SEED, temperature: 0 });
  });

  it("every request carries them — the design check and the brief reader — next to the unchanged JSON format and output limit", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return answer("{}");
    }) as unknown as typeof fetch;
    const provider = new GeminiProvider(configFor(), fetchImpl);
    await provider.analyzeDesign({ image, logo: null, context }, AbortSignal.timeout(5_000));
    await provider.extractRequirements({ text: "Price AED 99", allowedTypes: ["price"], sourceName: "brief.txt" }, AbortSignal.timeout(5_000));
    for (const body of bodies) {
      expect(body.generationConfig).toMatchObject({
        responseMimeType: "application/json",
        maxOutputTokens: 16_384,
        seed: GEMINI_SEED,
        thinkingConfig: { thinkingLevel: "LOW" },
      });
      expect(body.generationConfig).not.toHaveProperty("temperature"); // Gemini 3: the model's default
    }
    const older = new GeminiProvider(configFor("gemini-2.5-flash"), fetchImpl);
    await older.analyzeDesign({ image, logo: null, context }, AbortSignal.timeout(5_000));
    expect(bodies.at(-1)?.generationConfig).toMatchObject({ temperature: 0, thinkingConfig: { thinkingBudget: 0 } });
  });
});

describe("the day's quota used up: no retries", () => {
  const daily = "You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 250, model: gemini-3.8-flash. Quota id: GenerateRequestsPerDayPerProjectPerModel-FreeTier";
  const minute = "You exceeded your current quota. Quota id: GenerateRequestsPerMinutePerProjectPerModel-FreeTier";

  it("tells the daily quota apart from the per-minute one", () => {
    expect(isDailyQuota(daily)).toBe(true);
    expect(isDailyQuota("..._requests_per_day ...")).toBe(true);
    expect(isDailyQuota(minute)).toBe(false);
    expect(isDailyQuota("Resource has been exhausted (e.g. check quota).")).toBe(false);
  });

  it("a daily 429 is a daily_limit error (not retried); a per-minute 429 stays rate_limited (retried)", async () => {
    const fail = (response: Response) =>
      new GeminiProvider(configFor(), (async () => response) as unknown as typeof fetch)
        .analyzeDesign({ image, logo: null, context }, AbortSignal.timeout(5_000))
        .then(() => null, (e: ProviderError) => e);
    const day = await fail(google(429, daily));
    expect(day).toMatchObject({ kind: "daily_limit" });
    expect(day?.retryable).toBe(false);
    expect(day?.message).toContain("daily limit");
    expect(day?.message).not.toContain(KEY);
    const min = await fail(google(429, minute));
    expect(min).toMatchObject({ kind: "rate_limited" });
    expect(min?.retryable).toBe(true);
  });

  it("callProvider stops at once and the designer reads 'try again tomorrow' — a per-minute limit is still retried", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const result = await callProvider(
      async () => {
        calls++;
        throw new ProviderError("daily", "daily_limit");
      },
      () => ({ ok: true, value: "x" }),
      { timeoutMs: 1_000, runSignal: new AbortController().signal, sleep, retries: 2, provider: "gemini" }
    );
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: DESIGNER_MESSAGES.dailyLimit });
    expect(DESIGNER_MESSAGES.dailyLimit).toBe("Gemini's free daily limit has been reached — try again tomorrow.");
    expect(designerMessage("daily_limit", "mock")).toBe(DESIGNER_MESSAGES.dailyLimitOther);

    calls = 0;
    await callProvider(
      async () => {
        calls++;
        throw new ProviderError("minute", "rate_limited", 1_000);
      },
      () => ({ ok: true, value: "x" }),
      { timeoutMs: 1_000, runSignal: new AbortController().signal, sleep, retries: 2, provider: "gemini" }
    );
    expect(calls).toBe(3); // 2 retries, as before
  });
});
