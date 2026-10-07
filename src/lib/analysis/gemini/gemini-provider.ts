import type { GeminiConfig } from "@/lib/analysis/gemini/config";
import {
  DESIGN_ANALYSIS_SCHEMA,
  DESIGN_SYSTEM,
  designUserText,
  EXTRACT_SYSTEM,
  extractSchema,
  extractUserText,
  JUDGE_SCHEMA,
  JUDGE_SYSTEM,
  judgeUserText,
  READ_TEXT_SCHEMA,
  READ_TEXT_SYSTEM,
} from "@/lib/analysis/prompts";
import {
  GEMINI_LABEL,
  ProviderError,
  type AnalysisProvider,
  type DesignAnalysisInput,
  type ExtractRequirementsInput,
  type JudgeImageInput,
  type PreparedImage,
} from "@/lib/analysis/provider";

/**
 * The Gemini API provider (Google AI Studio, GEMINI_API_KEY). No Vertex AI,
 * no Cloud Vision, no billing setup: one generateContent call per design
 * (analyzeDesign) reads the text and describes the design, with the
 * confirmed requirements and company rules as context. Images are sent
 * inline from the server (prepared copies, never originals or file names);
 * the key goes in the x-goog-api-key header, never in a URL or a log.
 * Responses are returned RAW and validated outside (validate.ts); nothing
 * raw is stored. The "gemini" policy profile treats all of it as AI
 * evidence — it can never make a counting CRITICAL on its own.
 */

export type Fetch = typeof fetch;

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_OUTPUT_TOKENS = 16_384;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const image = (img: PreparedImage) => ({ inlineData: { mimeType: img.mime, data: b64(img.bytes) } });

/**
 * The response schema as sent to Gemini: minItems / maxItems removed (the
 * Gemini API answers 400 INVALID_ARGUMENT for them). The shared schemas keep
 * them, and validate.ts still enforces every length limit on the answer.
 */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== "minItems" && key !== "maxItems")
      .map(([key, value]) => [key, geminiSchema(value)])
  );
}

/** How far outside the 0–1000 scale a coordinate may be and still be clamped (1% of the scale). */
export const COORDINATE_TOLERANCE = 10;

const nudge = (value: unknown): unknown =>
  typeof value === "number" && Number.isFinite(value) && value >= -COORDINATE_TOLERANCE && value <= 1000 + COORDINATE_TOLERANCE
    ? Math.min(1000, Math.max(0, value))
    : value; // far out of range or not a number: left for validate.ts to reject

const nudgeBox = (box: unknown): unknown => (Array.isArray(box) ? box.map(nudge) : box);

/**
 * Gemini sometimes puts a coordinate just outside the 0–1000 scale (e.g. -2
 * at the very edge). Clamp those slightly-out values in the box_2d of each
 * text line, the logo box and the focal point, so one edge pixel doesn't
 * fail the whole analysis. Anything further out — or not a number — is left
 * as is, and the unchanged strict validator rejects it. The text is returned
 * untouched when nothing needed clamping (or it isn't JSON).
 */
export function clampGeminiCoordinates(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
  const answer = parsed as { texts?: unknown; logo?: unknown; focalPoint?: unknown };
  const before = JSON.stringify(answer);
  if (Array.isArray(answer.texts)) {
    for (const line of answer.texts) if (line && typeof line === "object" && "box_2d" in line) line.box_2d = nudgeBox(line.box_2d);
  }
  if (answer.logo && typeof answer.logo === "object" && "box" in answer.logo) answer.logo.box = nudgeBox(answer.logo.box);
  if (answer.focalPoint && typeof answer.focalPoint === "object") {
    const point = answer.focalPoint as { x?: unknown; y?: unknown };
    if ("x" in point) point.x = nudge(point.x);
    if ("y" in point) point.y = nudge(point.y);
  }
  const after = JSON.stringify(answer);
  return after === before ? raw : after;
}

const MAX_ERROR_CHARS = 200;

/** "HTTP 400: <Google's short message>" — single line, capped, the key removed. */
async function describeHttpError(response: Response, apiKey: string): Promise<string> {
  let message = "";
  try {
    const body = (await response.text()).slice(0, 20_000);
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
  } catch {
    // no readable error body: the status alone
  }
  if (apiKey) message = message.split(apiKey).join("[key]");
  message = message.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
  if (message.length > MAX_ERROR_CHARS) message = `${message.slice(0, MAX_ERROR_CHARS - 1)}…`;
  return message ? `HTTP ${response.status}: ${message}` : `HTTP ${response.status}`;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export class GeminiProvider implements AnalysisProvider {
  readonly name = "gemini" as const;
  readonly label = GEMINI_LABEL;
  readonly ocrFormat = "gemini-v1" as const;

  constructor(
    private readonly config: GeminiConfig,
    private readonly fetchImpl: Fetch = fetch
  ) {}

  /** One generateContent call; returns the model's JSON text (parts that aren't thoughts). */
  private async generate(system: string, parts: unknown[], schema: unknown, signal: AbortSignal, what: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.url, {
        method: "POST",
        headers: { "x-goog-api-key": this.config.apiKey, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", responseSchema: geminiSchema(schema), maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
        signal,
      });
    } catch {
      if (signal.aborted) throw new ProviderError(`The ${what} timed out.`, "timeout");
      throw new ProviderError(`The ${what} couldn't be reached.`, "network");
    }
    if (response.status === 429) {
      const retryAfter = retryAfterMs(response);
      throw new ProviderError(`The ${what} is busy or the free-tier limit was reached (${await describeHttpError(response, this.config.apiKey)}).`, "rate_limited", retryAfter);
    }
    if (response.status >= 500) {
      const retryAfter = retryAfterMs(response);
      throw new ProviderError(`The ${what} had a temporary problem (${await describeHttpError(response, this.config.apiKey)}).`, "server", retryAfter);
    }
    if (response.status === 401 || response.status === 403) throw new ProviderError(`The ${what} refused this server's API key.`, "auth");
    if (!response.ok) throw new ProviderError(`The ${what} rejected the request (${await describeHttpError(response, this.config.apiKey)}).`, "rejected");

    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_RESPONSE_BYTES) throw new ProviderError(`The ${what} response was too large.`, "invalid_response");
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) throw new ProviderError(`The ${what} response was too large.`, "invalid_response");

    let parsed: { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProviderError(`The ${what} returned an unreadable response.`, "invalid_response");
    }
    if (parsed.promptFeedback?.blockReason) throw new ProviderError(`The ${what} declined to analyse this.`, "rejected");
    const candidate = parsed.candidates?.[0];
    if (!candidate) throw new ProviderError(`The ${what} returned no answer.`, "invalid_response");
    if (candidate.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)) {
      throw new ProviderError(`The ${what} stopped early (${candidate.finishReason.toLowerCase()}).`, "invalid_response");
    }
    return (candidate.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
  }

  /** ONE call per design: text lines + visual judgement (DESIGN_ANALYSIS_SCHEMA). */
  async analyzeDesign(input: DesignAnalysisInput, signal: AbortSignal): Promise<string> {
    const parts: unknown[] = [image(input.image)];
    if (input.logo) parts.push(image(input.logo));
    parts.push({ text: designUserText(input.context, Boolean(input.logo)) });
    return clampGeminiCoordinates(await this.generate(DESIGN_SYSTEM, parts, DESIGN_ANALYSIS_SCHEMA, signal, "Gemini design check"));
  }

  /** Text only (information files that are images or scanned pages): READ_TEXT_SCHEMA. */
  async readText(img: PreparedImage, signal: AbortSignal): Promise<string> {
    return clampGeminiCoordinates(await this.generate(READ_TEXT_SYSTEM, [image(img), { text: "Read the text in this image." }], READ_TEXT_SCHEMA, signal, "Gemini text reader"));
  }

  /** Kept for the shared interface; the pipeline uses analyzeDesign for this provider. */
  async judgeImage(input: JudgeImageInput, signal: AbortSignal): Promise<string> {
    const parts: unknown[] = [image(input.image)];
    if (input.logo) parts.push(image(input.logo));
    parts.push({ text: judgeUserText(input.blocks, Boolean(input.logo)) });
    return clampGeminiCoordinates(await this.generate(JUDGE_SYSTEM, parts, JUDGE_SCHEMA, signal, "Gemini design check"));
  }

  /** Static designs only: video speech isn't analysed by this provider. */
  async transcribe(): Promise<string> {
    throw new ProviderError("Video isn't supported by the Gemini provider (static designs only).", "rejected");
  }

  async extractRequirements(input: ExtractRequirementsInput, signal: AbortSignal): Promise<string> {
    return this.generate(EXTRACT_SYSTEM, [{ text: extractUserText(input) }], extractSchema(input.allowedTypes), signal, "Gemini requirement reader");
  }
}
