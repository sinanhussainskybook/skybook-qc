import { describe, expect, it } from "vitest";
import { briefReadingLimit } from "@/lib/analysis/brief-reading-limit";
import { GEMINI_LIMITS, LOCAL_LIMITS } from "@/lib/analysis/limits";
import { BRIEF_TEXT_MAX_CHARS, BRIEF_TEXT_MESSAGES, briefTextLimit, checkBriefText, localReadingNote } from "@/lib/qc/brief-text";

/** Stage 2 follow-up: a typed brief is never longer than the AI reads, so nothing typed is cut short unseen. */

describe("how much of a brief the configured AI reads", () => {
  it("the worker's own limits: Local AI cpu 12,000 (also unset or invalid profile), gpu 30,000; Gemini and the others 60,000", () => {
    expect(briefReadingLimit({ QC_ANALYSIS_PROVIDER: "local" })).toEqual({ chars: 12_000, provider: "local" });
    expect(briefReadingLimit({ QC_ANALYSIS_PROVIDER: "local", QC_LOCAL_PROFILE: "cpu" }).chars).toBe(LOCAL_LIMITS.cpu.maxExtractionChars);
    expect(briefReadingLimit({ QC_ANALYSIS_PROVIDER: "local", QC_LOCAL_PROFILE: "nonsense" }).chars).toBe(12_000);
    expect(briefReadingLimit({ QC_ANALYSIS_PROVIDER: "local", QC_LOCAL_PROFILE: " GPU " }).chars).toBe(LOCAL_LIMITS.gpu.maxExtractionChars);
    expect(briefReadingLimit({ QC_ANALYSIS_PROVIDER: "gemini" })).toEqual({ chars: GEMINI_LIMITS.maxExtractionChars, provider: "gemini" });
    expect(briefReadingLimit({}).provider).toBeNull();
  });

  it("the typed-brief limit is 20,000, or less when the AI reads less", () => {
    expect(briefTextLimit(60_000)).toBe(BRIEF_TEXT_MAX_CHARS);
    expect(briefTextLimit(30_000)).toBe(BRIEF_TEXT_MAX_CHARS);
    expect(briefTextLimit(12_000)).toBe(12_000);
  });
});

describe("checking typed text against the reading limit", () => {
  it("Local AI: up to 12,000 is fine; longer is refused with the reason — never saved and cut short", () => {
    expect(checkBriefText("a".repeat(12_000), 12_000)).toMatchObject({ ok: true });
    const refused = checkBriefText("a".repeat(12_001), 12_000);
    expect(refused).toEqual({ ok: false, error: BRIEF_TEXT_MESSAGES.beyondReading(12_001, 12_000) });
    expect(BRIEF_TEXT_MESSAGES.beyondReading(12_001, 12_000)).toBe(
      "The brief text is 12,001 characters, but Local AI reads only the first 12,000 characters of each brief, so the rest would be missed. Shorten it, or save it in parts — each part is read in full."
    );
  });

  it("past 20,000 the general message wins (upload it as a file), whatever the AI", () => {
    expect(checkBriefText("a".repeat(25_000), 12_000)).toEqual({ ok: false, error: BRIEF_TEXT_MESSAGES.tooLong(25_000) });
  });

  it("the warning shown for uploaded briefs", () => {
    expect(localReadingNote(12_000)).toBe(
      "Local AI reads only the first 12,000 characters of each brief file or typed brief. If a brief is longer, split it into separate files or typed parts so nothing is missed."
    );
  });
});
