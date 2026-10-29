/**
 * Phase 6 resource limits (approved architecture, D5 / D6 / D10). One place,
 * so the worker, the media preparation and the validators agree.
 */
export const ANALYSIS_LIMITS = {
  /** Content files analysed per run (the content upload maximum is 10). */
  maxImagesPerRun: 10,
  /** PDF pages analysed per content file, and per run. */
  maxPagesPerFile: 10,
  maxPagesPerRun: 20,
  /** Video (D6). */
  maxVideoAnalysedMs: 15 * 60 * 1000,
  maxOcrFramesPerVideo: 120,
  maxKeyFramesPerVideo: 8,
  /** Design analysis runs per session (Try again included). Brief readings don't count. */
  maxRunsPerSession: 5,
  /**
   * Per user, across all their checks, and kept through Start over and new checks: AI analyses (design
   * checks and brief readings together) in any 24 hours, and how many may wait or run at once.
   */
  maxRunsPerUserPerDay: 30,
  maxActiveRunsPerUser: 2,

  /** Prepared images sent to providers. Both Vision and Gemini accept about 7 MB inline. */
  ocrImageLongEdge: 4096,
  judgeImageLongEdge: 2048,
  maxProviderImageBytes: 6_500_000,
  /** Information-file text sent for requirement extraction (characters). */
  maxExtractionChars: 60_000,
  maxInformationPagesPerFile: 20,

  /** Provider timeouts (ms). */
  ocrTimeoutMs: 20_000,
  judgeTimeoutMs: 60_000,
  audioTimeoutMs: 120_000,
  extractTimeoutMs: 60_000,
  ffmpegTimeoutMs: 120_000,
  /** Whole-run caps (ms). */
  imageRunTimeoutMs: 5 * 60 * 1000,
  videoRunTimeoutMs: 10 * 60 * 1000,

  /** Worker (D10). */
  maxConcurrentRuns: 2,
  maxProviderCallsPerRun: 3,
  heartbeatMs: 15_000,
  staleAfterMs: 2 * 60 * 1000,
  maxRunAttempts: 3,
  /** Per provider call: 2 retries = 3 attempts. */
  maxCallRetries: 2,
  /** Whether a call that timed out is tried again (not for slow local models). */
  retryTimeouts: true,
  /** Frames (images, pages, video key frames) judged by the AI per run; the rest get OCR only. */
  maxJudgedFramesPerRun: 1_000,
} as const;

type Widen<T> = { readonly [K in keyof T]: T[K] extends number ? number : T[K] extends boolean ? boolean : T[K] };
/** The limits one provider runs under (file / page / video caps are the same for every provider). */
export type AnalysisLimits = Widen<typeof ANALYSIS_LIMITS>;

export type LocalProfile = "cpu" | "gpu";

/**
 * The local provider (PaddleOCR + Ollama + whisper.cpp on this server).
 * Measured on the 2026-10-06 trial (CPU only, i7-4790, 8 GB): OCR 0.3 s per
 * design, Qwen3-VL 4B judgement 239–310 s, whisper base 15 s per minute of
 * audio. One model call at a time — the model can't run two at once.
 *   cpu: testing only, NOT for designer use (minutes per design);
 *   gpu: production target — starting values, to confirm by the GPU
 *        acceptance benchmark before go-live.
 */
export const LOCAL_LIMITS: Record<LocalProfile, AnalysisLimits> = {
  cpu: {
    ...ANALYSIS_LIMITS,
    judgeImageLongEdge: 1024,
    maxKeyFramesPerVideo: 3,
    maxJudgedFramesPerRun: 3,
    maxExtractionChars: 12_000,
    ocrTimeoutMs: 30_000,
    judgeTimeoutMs: 600_000,
    audioTimeoutMs: 600_000,
    extractTimeoutMs: 600_000,
    imageRunTimeoutMs: 30 * 60 * 1000,
    videoRunTimeoutMs: 30 * 60 * 1000,
    maxConcurrentRuns: 1,
    maxProviderCallsPerRun: 1,
    maxCallRetries: 1,
    retryTimeouts: false,
    // A long model call must not look like a dead worker.
    staleAfterMs: 15 * 60 * 1000,
  },
  gpu: {
    ...ANALYSIS_LIMITS,
    judgeImageLongEdge: 1024,
    maxKeyFramesPerVideo: 8,
    maxJudgedFramesPerRun: 10,
    maxExtractionChars: 30_000,
    ocrTimeoutMs: 30_000,
    judgeTimeoutMs: 120_000,
    audioTimeoutMs: 300_000,
    extractTimeoutMs: 120_000,
    imageRunTimeoutMs: 10 * 60 * 1000,
    videoRunTimeoutMs: 15 * 60 * 1000,
    maxConcurrentRuns: 1,
    maxProviderCallsPerRun: 1,
    maxCallRetries: 1,
    retryTimeouts: false,
    staleAfterMs: 5 * 60 * 1000,
  },
};

/**
 * The Gemini API free tier (Google AI Studio): low per-minute / per-day
 * request quotas, so one design at a time and ONE call per design
 * (analyzeDesign). Rate-limit answers (429) are retried after Retry-After.
 */
export const GEMINI_LIMITS: AnalysisLimits = {
  ...ANALYSIS_LIMITS,
  judgeImageLongEdge: 2048,
  maxJudgedFramesPerRun: 10,
  judgeTimeoutMs: 120_000,
  ocrTimeoutMs: 120_000,
  extractTimeoutMs: 120_000,
  maxConcurrentRuns: 1,
  maxProviderCallsPerRun: 1,
  maxCallRetries: 2,
  imageRunTimeoutMs: 15 * 60 * 1000,
  staleAfterMs: 5 * 60 * 1000,
};

/** The limits for the configured provider. Mock and Google keep the approved Phase 6 values. */
export function limitsFor(provider: "mock" | "google" | "local" | "gemini" | null, profile: LocalProfile = "cpu"): AnalysisLimits {
  if (provider === "gemini") return GEMINI_LIMITS;
  return provider === "local" ? LOCAL_LIMITS[profile] : ANALYSIS_LIMITS;
}
