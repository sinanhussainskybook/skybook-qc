import { GoogleAuth } from "google-auth-library";
import type { GoogleConfig } from "@/lib/analysis/google/config";
import {
  extractSchema,
  EXTRACT_SYSTEM,
  extractUserText,
  JUDGE_SCHEMA,
  JUDGE_SYSTEM,
  judgeUserText,
  TRANSCRIBE_SYSTEM,
  TRANSCRIPT_SCHEMA_GOOGLE,
} from "@/lib/analysis/google/prompts";
import {
  ProviderError,
  type AnalysisProvider,
  type ExtractRequirementsInput,
  type JudgeImageInput,
  type PreparedImage,
  type TranscribeInput,
} from "@/lib/analysis/provider";

/**
 * The Google provider (D5): Cloud Vision DOCUMENT_TEXT_DETECTION for text,
 * Gemini on Gemini Enterprise Agent Platform (formerly Vertex AI) for
 * judgements, transcripts and requirement candidates — both on the EU
 * endpoints. Bytes are sent inline from the server; no file names, no URLs,
 * no customer contact data. Responses are returned RAW for validation.
 *
 * Request/response logging is a project setting that stays OFF (it is off
 * by default); nothing here turns it on. Zero data retention depends on
 * Google's exception for the project — REQUESTED / PENDING, not assumed.
 */

export type TokenSource = () => Promise<string>;
export type Fetch = typeof fetch;

/** Raw responses are capped before they are read (validation re-checks). */
const MAX_RESPONSE_BYTES = 10_000_000;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export function serviceAccountTokens(credentialsFile: string): TokenSource {
  const auth = new GoogleAuth({ keyFile: credentialsFile, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new ProviderError("Google sign-in for the analysis service failed.", "auth");
    return token;
  };
}

async function readCapped(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_RESPONSE_BYTES) throw new ProviderError("The analysis response was too large.", "invalid_response");
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new ProviderError("The analysis response was too large.", "invalid_response");
  return text;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export class GoogleProvider implements AnalysisProvider {
  readonly name = "google" as const;
  readonly label = "Google Cloud Vision + Gemini";

  constructor(
    private readonly config: GoogleConfig,
    private readonly tokens: TokenSource,
    private readonly fetchImpl: Fetch = fetch
  ) {}

  private async post(url: string, body: unknown, signal: AbortSignal, what: string): Promise<string> {
    let response: Response;
    try {
      const token = await this.tokens();
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal.aborted) throw new ProviderError(`The ${what} timed out.`, "timeout");
      throw new ProviderError(`The ${what} couldn't be reached.`, "network");
    }
    if (response.status === 429) throw new ProviderError(`The ${what} is busy.`, "rate_limited", retryAfterMs(response));
    if (response.status >= 500) throw new ProviderError(`The ${what} had a temporary problem.`, "server", retryAfterMs(response));
    if (response.status === 401 || response.status === 403) throw new ProviderError(`The ${what} refused this server's credentials.`, "auth");
    if (!response.ok) throw new ProviderError(`The ${what} rejected the request.`, "rejected");
    return readCapped(response);
  }

  async readText(image: PreparedImage, signal: AbortSignal): Promise<string> {
    return this.post(
      this.config.visionUrl,
      { requests: [{ image: { content: b64(image.bytes) }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }] },
      signal,
      "text reader"
    );
  }

  /** One Gemini call; returns the model's JSON text (the parts that aren't thoughts). */
  private async gemini(system: string, parts: unknown[], schema: unknown, signal: AbortSignal, what: string): Promise<string> {
    const raw = await this.post(
      this.config.geminiUrl,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
          thinkingConfig: { thinkingLevel: "LOW" },
          maxOutputTokens: 16_384,
        },
      },
      signal,
      what
    );
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

  async judgeImage(input: JudgeImageInput, signal: AbortSignal): Promise<string> {
    const parts: unknown[] = [{ inlineData: { mimeType: input.image.mime, data: b64(input.image.bytes) } }];
    if (input.logo) parts.push({ inlineData: { mimeType: input.logo.mime, data: b64(input.logo.bytes) } });
    parts.push({ text: judgeUserText(input.blocks, Boolean(input.logo)) });
    return this.gemini(JUDGE_SYSTEM, parts, JUDGE_SCHEMA, signal, "design checker");
  }

  async transcribe(input: TranscribeInput, signal: AbortSignal): Promise<string> {
    return this.gemini(
      TRANSCRIBE_SYSTEM,
      [{ inlineData: { mimeType: input.mime, data: b64(input.bytes) } }, { text: `Audio length: ${input.durationMs} ms.` }],
      TRANSCRIPT_SCHEMA_GOOGLE,
      signal,
      "transcription service"
    );
  }

  async extractRequirements(input: ExtractRequirementsInput, signal: AbortSignal): Promise<string> {
    return this.gemini(EXTRACT_SYSTEM, [{ text: extractUserText(input) }], extractSchema(input.allowedTypes), signal, "requirement reader");
  }
}
