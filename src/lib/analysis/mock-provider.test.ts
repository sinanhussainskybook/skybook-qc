import { describe, expect, it } from "vitest";
import { MockProvider } from "@/lib/analysis/mock-provider";
import { MOCK_LABEL, ProviderError, type PreparedImage } from "@/lib/analysis/provider";
import { validateImageJudgement, validateOcrResponse, validateRequirementCandidates, validateTranscript } from "@/lib/analysis/validate";

/** Plan 6.2 — the mock goes through the same validation as a real provider and is always labelled. */
describe("mock provider", () => {
  const image = (sourceName = "poster.png"): PreparedImage => ({ key: "f1", mime: "image/png", bytes: new Uint8Array(1), width: 1000, height: 1250, sourceName });
  const signal = () => new AbortController().signal;

  it("is labelled and its sample text says so", async () => {
    const mock = new MockProvider();
    expect(mock.name).toBe("mock");
    expect(mock.label).toBe("Sample data — not real AI");
    const ocr = validateOcrResponse(await mock.readText(image(), signal()), 1000, 1250);
    expect(ocr.ok && ocr.value.blocks.map((b) => b.text)).toEqual([MOCK_LABEL, "Sample headline", "Book now"]);
  });

  it("every response passes strict validation", async () => {
    const mock = new MockProvider();
    const ocr = validateOcrResponse(await mock.readText(image(), signal()), 1000, 1250);
    if (!ocr.ok) throw new Error(ocr.reason);
    const blocks = ocr.value.blocks.map((b) => ({ id: b.id, text: b.text }));
    const judged = validateImageJudgement(await mock.judgeImage({ image: image(), logo: null, blocks }, signal()), new Set(blocks.map((b) => b.id)));
    expect(judged.ok).toBe(true);
    expect(validateTranscript(await mock.transcribe({ mime: "audio/mp3", bytes: new Uint8Array(1), durationMs: 5000 }, signal()), 5000).ok).toBe(true);
    expect(validateRequirementCandidates(await mock.extractRequirements({ text: "\nPrice AED 99\n", allowedTypes: [] }, signal())).ok).toBe(true);
  });

  it("scenarios: fail, retry-once, malformed", async () => {
    const mock = new MockProvider();
    await expect(mock.readText(image("x-mock-fail.png"), signal())).rejects.toMatchObject({ kind: "rejected", retryable: false });
    const first = mock.readText(image("x-mock-retry.png"), signal());
    await expect(first).rejects.toBeInstanceOf(ProviderError);
    await expect(first).rejects.toMatchObject({ retryable: true });
    await expect(mock.readText(image("x-mock-retry.png"), signal())).resolves.toContain("responses");
    const bad = await mock.judgeImage({ image: image("x-mock-malformed.png"), logo: null, blocks: [] }, signal());
    expect(validateImageJudgement(bad, new Set()).ok).toBe(false);
  });

  it("honours cancellation (time limits)", async () => {
    const mock = new MockProvider({ delayMs: 5_000 });
    const controller = new AbortController();
    const pending = mock.readText(image(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "timeout" });
  });
});
