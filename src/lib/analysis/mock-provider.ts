import {
  MOCK_LABEL,
  ProviderError,
  type AnalysisProvider,
  type ExtractRequirementsInput,
  type JudgeImageInput,
  type PreparedImage,
  type TranscribeInput,
} from "@/lib/analysis/provider";

/**
 * The mock provider (plan 6.2). Deterministic SAMPLE responses in the same
 * raw formats the real services return, so the whole pipeline — validation,
 * ContentDetections, the confidence policy, findings, failures, progress and
 * clean-up — runs without any AI. Every result it produces is labelled
 * "Sample data — not real AI" (the run records provider = "mock", and the
 * screen shows the label); its sample text even says so.
 *
 * Test scenarios are chosen by markers in the uploaded file's name:
 *   "mock-fail"      → the call fails (not retryable)
 *   "mock-retry"     → the first call fails with a retryable error, then succeeds
 *   "mock-malformed" → the AI judgement is invalid JSON
 *   "mock-slow"      → each call waits a little longer (to watch progress)
 */

export type MockOptions = { delayMs?: number };

const SAMPLE_LINES = ["Sample data — not real AI", "Sample headline", "Book now"];

function paragraphsFor(width: number, height: number) {
  const rows = [
    { y: 0.06, h: 0.05 },
    { y: 0.3, h: 0.1 },
    { y: 0.75, h: 0.06 },
  ];
  return SAMPLE_LINES.map((text, i) => {
    const x = Math.round(width * 0.1);
    const y = Math.round(height * rows[i].y);
    const w = Math.round(width * 0.8);
    const h = Math.max(1, Math.round(height * rows[i].h));
    const poly = (px: number, py: number, pw: number, ph: number) => ({
      vertices: [{ x: px, y: py }, { x: px + pw, y: py }, { x: px + pw, y: py + ph }, { x: px, y: py + ph }],
    });
    const words = text.split(" ");
    const ww = Math.max(1, Math.round(w / words.length));
    return {
      boundingBox: poly(x, y, w, h),
      confidence: 0.95,
      words: words.map((word, j) => ({
        boundingBox: poly(x + j * ww, y, ww, h),
        confidence: 0.95,
        symbols: [...word].map((ch, k) => ({
          text: ch,
          ...(k === word.length - 1 && j < words.length - 1 ? { property: { detectedBreak: { type: "SPACE" } } } : {}),
        })),
      })),
    };
  });
}

export class MockProvider implements AnalysisProvider {
  readonly name = "mock" as const;
  readonly label = MOCK_LABEL;
  private readonly delayMs: number;
  private readonly retried = new Set<string>();

  constructor(options: MockOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
  }

  private async behave(sourceName: string | undefined, key: string, signal: AbortSignal) {
    const name = (sourceName ?? "").toLowerCase();
    const wait = this.delayMs * (name.includes("mock-slow") ? 4 : 1);
    if (wait > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new ProviderError("The request timed out.", "timeout"));
        });
      });
    }
    if (signal.aborted) throw new ProviderError("The request timed out.", "timeout");
    if (name.includes("mock-fail")) throw new ProviderError("Sample failure (mock provider).", "rejected");
    if (name.includes("mock-retry") && !this.retried.has(key)) {
      this.retried.add(key);
      throw new ProviderError("Sample temporary failure (mock provider).", "server");
    }
  }

  async readText(image: PreparedImage, signal: AbortSignal): Promise<string> {
    await this.behave(image.sourceName, `ocr:${image.key}`, signal);
    return JSON.stringify({
      responses: [
        {
          fullTextAnnotation: {
            pages: [{ width: image.width, height: image.height, confidence: 0.95, blocks: paragraphsFor(image.width, image.height).map((p) => ({ paragraphs: [p] })) }],
          },
        },
      ],
    });
  }

  async judgeImage(input: JudgeImageInput, signal: AbortSignal): Promise<string> {
    await this.behave(input.image.sourceName, `judge:${input.image.key}`, signal);
    if ((input.image.sourceName ?? "").toLowerCase().includes("mock-malformed")) return "{ this is not json";
    const roleFor = (text: string) => (text === "Sample headline" ? "headline" : text === "Book now" ? "cta" : "other");
    return JSON.stringify({
      blocks: input.blocks.map((b) => ({ id: b.id, role: roleFor(b.text), fontFamily: "Sample Sans", bold: false, certainty: "likely" })),
      fonts: [{ family: "Sample Sans", certainty: "likely" }],
      logo: { present: false, matchesCompanyLogo: null, box: null, certainty: "unsure" },
      focalPoint: { x: 500, y: 500, certainty: "unsure" },
      imageIssues: [],
      colorOnlyMeaning: { present: false, certainty: "unsure", note: "Sample data — not real AI" },
    });
  }

  async transcribe(input: TranscribeInput, signal: AbortSignal): Promise<string> {
    await this.behave(input.sourceName, "transcribe", signal);
    const end = Math.max(1, Math.min(2_000, input.durationMs));
    return JSON.stringify({ hasSpeech: true, segments: [{ startMs: 0, endMs: end, text: "Sample speech — not real AI", certainty: "likely" }] });
  }

  async extractRequirements(input: ExtractRequirementsInput, signal: AbortSignal): Promise<string> {
    await this.behave(input.sourceName, `extract:${input.sourceName}`, signal);
    const first = input.text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 120);
    return JSON.stringify({
      candidates: first ? [{ type: "required_text", label: "Sample data — not real AI", value: first, quote: first }] : [],
    });
  }
}
