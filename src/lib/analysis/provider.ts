/**
 * The provider interface (plan 6.1) — the only thing the rest of Phase 6
 * knows about an AI / OCR service. Google (6.3) and the labelled mock (6.2)
 * implement it; Claude could later, behind the same shape.
 *
 * Every method returns the provider's RAW response text. Nothing a provider
 * returns is trusted: lib/analysis/validate.ts parses and checks every
 * response against a fixed shape and size before it can become a detection
 * (6.8). A provider never decides a finding, a severity or a result.
 */

/** An image prepared locally for a provider (lib/analysis/media/*): never the original upload. */
export type PreparedImage = {
  /** Our own id for this image within the run, e.g. "<fileId>#p2" or "<fileId>@12000". */
  key: string;
  mime: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  /** Size of the prepared image in pixels. */
  width: number;
  height: number;
  /**
   * The uploaded file's name. Only the labelled mock reads it (test
   * scenarios); real providers never send it anywhere.
   */
  sourceName?: string;
};

/** One OCR text block given to the AI to label — the AI sees ids, never authors text. */
export type OcrBlockRef = { id: string; text: string };

export type JudgeImageInput = {
  image: PreparedImage;
  /** The company's saved logo, prepared the same way, or null when none is saved. */
  logo: PreparedImage | null;
  /** The text the OCR found in this image, numbered. */
  blocks: OcrBlockRef[];
};

export type TranscribeInput = {
  sourceName?: string;
  mime: "audio/mp3";
  bytes: Uint8Array;
  durationMs: number;
};

export type ExtractRequirementsInput = {
  sourceName?: string;
  /** Text read from one information file (already truncated to the limit). */
  text: string;
  /** The requirement types the answer may use (lib/qc/requirements.ts). */
  allowedTypes: readonly string[];
};

/**
 * What the client asked for and the company's saved rules, given to a
 * provider that analyses a whole design in ONE call (analyzeDesign) so it
 * knows what to look for. Only confirmed requirements; no contact details.
 * The provider still only DESCRIBES the design — the Phase 5 rules decide.
 */
export type DesignContext = {
  companyName: string;
  requirements: { type: string; label: string | null; value: string }[];
  goldenRules: string[];
  brandColours: string[];
  brandFonts: string[];
  approvedTerms: string[];
  bannedTerms: string[];
};

export type DesignAnalysisInput = { image: PreparedImage; logo: PreparedImage | null; context: DesignContext };

export type ProviderName = "mock" | "google" | "local" | "gemini";

export interface AnalysisProvider {
  readonly name: ProviderName;
  /** Shown wherever results appear. The mock's is "Sample data — not real AI". */
  readonly label: string;
  /**
   * Which OCR response shape readText returns: Cloud Vision's (Google and
   * the mock) or the local PaddleOCR adapter's ("local-v1"). Chooses the
   * validator; both produce the same OcrResult.
   */
  readonly ocrFormat?: "vision" | "local-v1" | "gemini-v1";
  /** OCR (6.4). Raw provider response text. */
  readText(image: PreparedImage, signal: AbortSignal): Promise<string>;
  /** Visual judgements (6.5). Raw JSON text matching IMAGE_JUDGEMENT_SCHEMA. */
  judgeImage(input: JudgeImageInput, signal: AbortSignal): Promise<string>;
  /** Speech to text for video audio (6.6). Raw JSON text matching TRANSCRIPT_SCHEMA. */
  transcribe(input: TranscribeInput, signal: AbortSignal): Promise<string>;
  /** Candidate requirements from information-file text (6.7). Raw JSON text. */
  extractRequirements(input: ExtractRequirementsInput, signal: AbortSignal): Promise<string>;
  /**
   * Optional: text AND visual judgement of one design in a single call (the
   * Gemini API provider). Raw JSON matching DESIGN_ANALYSIS_SCHEMA; when a
   * provider has it, the pipeline uses it instead of readText + judgeImage.
   */
  analyzeDesign?(input: DesignAnalysisInput, signal: AbortSignal): Promise<string>;
}

/** A provider error the worker can classify (retry or not). Message is safe to show. */
export class ProviderError extends Error {
  constructor(
    message: string,
    /** daily_limit: the provider's quota for the day is used up — trying again soon can't help. */
    readonly kind: "timeout" | "rate_limited" | "daily_limit" | "server" | "network" | "rejected" | "auth" | "invalid_response",
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    return this.kind === "timeout" || this.kind === "rate_limited" || this.kind === "server" || this.kind === "network";
  }
}

export const MOCK_LABEL = "Sample data — not real AI";
export const LOCAL_LABEL = "Local AI";
export const GEMINI_LABEL = "Gemini (Google AI Studio)";
