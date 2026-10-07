import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Database } from "@/lib/db/database";
import { cancelRun, failRun, finishRun, heartbeat, type AnalysisRun } from "@/lib/db/analysis-runs";
import { findAccessibleCompany } from "@/lib/db/companies";
import { loadCompanyConfiguration } from "@/lib/db/company-config";
import { findOwnedSession, listFiles, listRequirements, type QcFile } from "@/lib/db/qc-sessions";
import { findUserById } from "@/lib/db/users";
import type { Company, CompanyConfiguration } from "@/lib/company/types";
import type { BucketClient } from "@/lib/storage/storage-api";
import { assembleDetections, type FrameAnalysis } from "@/lib/analysis/assemble";
import { callProvider, DESIGNER_MESSAGES, inPool, RunAborted } from "@/lib/analysis/call";
import { ANALYSIS_LIMITS, type AnalysisLimits } from "@/lib/analysis/limits";
import type { MediaPreparer, PreparedContent } from "@/lib/analysis/media/types";
import type { AnalysisProvider, DesignContext, PreparedImage } from "@/lib/analysis/provider";
import { ocrValidator, validateDesignAnalysis, validateImageJudgement, validateTranscript, type Transcript } from "@/lib/analysis/validate";
import { processInformationRun } from "@/lib/analysis/information";

/**
 * Processing one analysis run (plan 6.10). The worker calls this for a run it
 * has claimed. In order:
 *   1. re-check who may use the session (owner, still a member, not expired);
 *   2. check the files are still the ones the run was queued for;
 *   3. prepare each file locally, read its text (OCR), judge it (AI);
 *   4. build ONE validated ContentDetections; re-check access; store it.
 * Temporary files live in a per-run folder that is always removed.
 */

export type RunDeps = {
  db: Database;
  storage: BucketClient;
  logoStorage: BucketClient | null;
  provider: AnalysisProvider;
  preparer: MediaPreparer;
  tempRoot: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  heartbeatMs?: number;
  /** The provider's limits (lib/analysis/limits.ts); defaults to the approved Phase 6 values. */
  limits?: AnalysisLimits;
};

/** The limits a run uses. */
export const limitsOf = (deps: Pick<RunDeps, "limits">): AnalysisLimits => deps.limits ?? ANALYSIS_LIMITS;

export const SAFE_REASONS = {
  unavailable: "This QC session isn't available any more.",
  changed: "The files changed after the analysis started — run it again.",
  nothing: "There is no content to analyse.",
  stopped: DESIGNER_MESSAGES.timedOut,
  failed: "The analysis couldn't read the content.",
} as const;

/** Which files a run analyses — a result only applies while they are unchanged. */
export function filesFingerprint(files: Pick<QcFile, "id" | "file_size">[]): string {
  const ids = files.map((f) => `${f.id}:${f.file_size}`).sort().join("|");
  return `${files.length}:${createHash("sha256").update(ids).digest("hex").slice(0, 40)}`;
}

/**
 * What a one-call provider (analyzeDesign) is told to look for: the
 * session's CONFIRMED requirements and the company's saved rules. No
 * contact details, no unconfirmed requirements. Context only — the Phase 5
 * rules still compare and decide.
 */
export async function designContextOf(db: Database, sessionId: string, config: CompanyConfiguration): Promise<DesignContext> {
  const requirements = (await listRequirements(db, sessionId)).filter((r) => r.confirmed);
  return {
    companyName: config.company.name,
    requirements: requirements.map((r) => ({ type: r.type, label: r.label, value: r.expected_value })),
    goldenRules: config.goldenRules.filter((g) => g.active).map((g) => (g.approved_value ? `${g.rule}: ${g.approved_value}` : g.rule)),
    brandColours: config.brand.colors.map((c) => [c.name, c.hex].filter(Boolean).join(" ")),
    brandFonts: config.brand.fonts.map((f) => f.family),
    approvedTerms: config.brand.terms.filter((t) => t.kind === "approved").map((t) => t.term),
    bannedTerms: config.brand.terms.filter((t) => t.kind === "banned").map((t) => t.term),
  };
}

/** The access check the page and actions make, repeated by the worker. */
export async function authorizeRun(db: Database, run: AnalysisRun, now: Date): Promise<{ company: Company; sessionId: string } | null> {
  const session = await findOwnedSession(db, run.session_id, run.requested_by, now);
  if (!session) return null;
  const user = await findUserById(db, run.requested_by);
  if (!user?.active) return null;
  const company = await findAccessibleCompany(db, { id: user.id, role: user.role }, session.company_id);
  return company ? { company, sessionId: session.id } : null;
}

export async function processRun(deps: RunDeps, run: AnalysisRun): Promise<"done" | "failed" | "cancelled" | "lost"> {
  const now = deps.now ?? (() => new Date());
  const access = await authorizeRun(deps.db, run, now());
  if (!access) {
    await cancelRun(deps.db, run.id, SAFE_REASONS.unavailable, now());
    return "cancelled";
  }

  const limits = limitsOf(deps);
  const controller = new AbortController();
  // Whole-run cap: 10 minutes when there is video to process, otherwise 5.
  const hasVideo = (await listFiles(deps.db, access.sessionId, "ready")).some((f) => f.mime_type.startsWith("video/"));
  const deadline = setTimeout(
    () => controller.abort(),
    run.kind === "content" && hasVideo ? limits.videoRunTimeoutMs : limits.imageRunTimeoutMs
  );
  const progress = { stage: "Starting", done: 0, total: 1 };
  const beat = setInterval(() => {
    heartbeat(deps.db, run.id, now(), progress)
      .then((ours) => {
        if (!ours) controller.abort(); // cancelled or taken over: stop
      })
      .catch(() => {});
  }, deps.heartbeatMs ?? limits.heartbeatMs);
  const workDir = path.join(deps.tempRoot, run.id);
  try {
    await mkdir(workDir, { recursive: true });
    if (run.kind === "information") {
      return await processInformationRun(deps, run, access, controller.signal, progress);
    }
    return await processContentRun(deps, run, access, controller.signal, progress, workDir);
  } catch (error) {
    if (error instanceof RunAborted || controller.signal.aborted) {
      const failed = await failRun(deps.db, run.id, SAFE_REASONS.stopped, now());
      return failed ? "failed" : "lost";
    }
    console.error(`Analysis run ${run.id} failed:`, error instanceof Error ? error.name : "error");
    return (await failRun(deps.db, run.id, SAFE_REASONS.failed, now())) ? "failed" : "lost";
  } finally {
    clearTimeout(deadline);
    clearInterval(beat);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function processContentRun(
  deps: RunDeps,
  run: AnalysisRun,
  access: { company: Company; sessionId: string },
  signal: AbortSignal,
  progress: { stage: string; done: number; total: number },
  workDir: string
): Promise<"done" | "failed" | "cancelled" | "lost"> {
  const now = deps.now ?? (() => new Date());
  const limits = limitsOf(deps);
  const files = (await listFiles(deps.db, access.sessionId, "ready")).filter((f) => f.kind === "content").slice(0, limits.maxImagesPerRun);
  if (filesFingerprint(files) !== run.files_fingerprint) {
    await cancelRun(deps.db, run.id, SAFE_REASONS.changed, now());
    return "cancelled";
  }
  if (!files.length) return (await failRun(deps.db, run.id, SAFE_REASONS.nothing, now())) ? "failed" : "lost";

  // The saved logo, for the AI to compare with (never stored with the run).
  const config = await loadCompanyConfiguration(deps.db, access.company);
  let logo: PreparedImage | null = null;
  if (config.logo && deps.logoStorage) {
    const stored = await deps.logoStorage.readStart(config.logo.storage_path, config.logo.file_size + 1).catch(() => null);
    if (stored) logo = await deps.preparer.prepareLogo(stored.bytes, config.logo.mime_type).catch(() => null);
  }

  // 1. Prepare every file locally.
  progress.stage = "Preparing files";
  const prepared: PreparedContent[] = [];
  let pagesLeft = limits.maxPagesPerRun;
  for (const file of files) {
    if (signal.aborted) throw new RunAborted();
    const stored = await deps.storage.readStart(file.storage_path, file.file_size + 1);
    if (!stored) {
      prepared.push({ frames: [], analysedShare: 0, unsupported: "the file couldn't be read from storage" });
      continue;
    }
    const content = await deps.preparer.prepareContent(
      {
        id: file.id,
        fileName: file.file_name,
        mimeType: file.mime_type,
        width: file.media_width,
        height: file.media_height,
        durationMs: file.media_duration_ms,
        pages: file.media_pages,
      },
      stored.bytes,
      workDir,
      signal
    );
    // The per-run page limit: pages beyond it are not analysed (and lower the coverage).
    if (content.frames.some((f) => f.page !== undefined)) {
      const kept = content.frames.slice(0, Math.max(0, pagesLeft));
      content.analysedShare *= content.frames.length ? kept.length / content.frames.length : 1;
      content.frames = kept;
      pagesLeft -= kept.length;
    }
    prepared.push(content);
  }

  // Per-run AI judgement cap (local CPU: 3): later frames get OCR and measurements only,
  // so their AI checks stay not verified.
  let judgeSlots = limits.maxJudgedFramesPerRun;
  for (const f of prepared.flatMap((p) => p.frames)) {
    if (f.judgeImage && judgeSlots-- <= 0) f.judgeImage = null;
  }
  const frames = prepared.flatMap((p) => p.frames);
  const audio = prepared.find((p) => p.audio)?.audio ?? null;
  const judged = frames.filter((f) => f.judgeImage).length;
  // A one-call provider (analyzeDesign) reads and judges a design together: one step per design.
  const designContext = deps.provider.analyzeDesign ? await designContextOf(deps.db, access.sessionId, config) : null;
  progress.total = frames.length + (designContext ? 0 : judged) + (audio?.bytes ? 1 : 0);
  progress.done = 0;
  const step = async (stage: string) => {
    progress.stage = stage;
    progress.done++;
    await heartbeat(deps.db, run.id, now(), progress);
  };

  // 2. Read and judge each frame — at most 3 provider calls at a time.
  const results: FrameAnalysis[] = frames.map((f) => ({
    fileId: f.fileId,
    page: f.page,
    timeMs: f.timeMs,
    intervalMs: f.intervalMs,
    frame: f.frame,
    ocr: null,
    judgement: null,
    colours: null,
  }));
  const problems: string[] = [];
  await inPool(frames, limits.maxProviderCallsPerRun, async (frame, i) => {
    if (designContext && frame.judgeImage && deps.provider.analyzeDesign) {
      const image = frame.judgeImage;
      const analysed = await callProvider(
        (s) => deps.provider.analyzeDesign!({ image, logo, context: designContext }, s),
        (raw) => validateDesignAnalysis(raw, image.width, image.height),
        { timeoutMs: limits.judgeTimeoutMs, runSignal: signal, sleep: deps.sleep, retries: limits.maxCallRetries, retryTimeouts: limits.retryTimeouts, provider: deps.provider.name }
      );
      await step("Checking the design");
      if (!analysed.ok) {
        problems.push(analysed.reason);
        return;
      }
      results[i].ocr = analysed.value.ocr;
      results[i].judgement = analysed.value.judgement;
      // Colours are still MEASURED from the pixels, inside the boxes Gemini gave.
      if (frame.measureColours) results[i].colours = await frame.measureColours(analysed.value.ocr.blocks).catch(() => null);
      return;
    }
    const ocr = await callProvider(
      (s) => deps.provider.readText(frame.ocrImage, s),
      (raw) => ocrValidator(deps.provider)(raw, frame.ocrImage.width, frame.ocrImage.height),
      { timeoutMs: limits.ocrTimeoutMs, runSignal: signal, sleep: deps.sleep, retries: limits.maxCallRetries, retryTimeouts: limits.retryTimeouts, provider: deps.provider.name }
    );
    await step("Reading text");
    if (!ocr.ok) {
      problems.push(ocr.reason);
      return;
    }
    results[i].ocr = ocr.value;
    if (frame.measureColours) results[i].colours = await frame.measureColours(ocr.value.blocks).catch(() => null);
    if (!frame.judgeImage) return;
    const refs = ocr.value.blocks.slice(0, 300).map((b) => ({ id: b.id, text: b.text }));
    const ids = new Set(refs.map((r) => r.id));
    const judged = await callProvider(
      (s) => deps.provider.judgeImage({ image: frame.judgeImage!, logo, blocks: refs }, s),
      (raw) => validateImageJudgement(raw, ids),
      { timeoutMs: limits.judgeTimeoutMs, runSignal: signal, sleep: deps.sleep, retries: limits.maxCallRetries, retryTimeouts: limits.retryTimeouts, provider: deps.provider.name }
    );
    await step("Checking the design");
    if (judged.ok) results[i].judgement = judged.value;
    else problems.push(judged.reason);
  });

  // 3. Speech (video).
  let transcript: Transcript | null = null;
  if (audio?.bytes) {
    const heard = await callProvider(
      (s) => deps.provider.transcribe({ mime: audio.mime, bytes: audio.bytes!, durationMs: audio.durationMs, sourceName: files[0].file_name }, s),
      (raw) => validateTranscript(raw, audio.durationMs),
      { timeoutMs: limits.audioTimeoutMs, runSignal: signal, sleep: deps.sleep, retries: limits.maxCallRetries, retryTimeouts: limits.retryTimeouts, provider: deps.provider.name }
    );
    await step("Listening");
    if (heard.ok) transcript = heard.value;
    else problems.push(heard.reason);
  } else if (audio && !audio.hasAudio) {
    transcript = { hasSpeech: false, segments: [] };
  }

  // 4. Nothing usable at all → the run failed (with the first plain reason).
  const unsupported = prepared.find((p) => p.unsupported)?.unsupported;
  const anything = results.some((r) => r.ocr || r.judgement) || transcript !== null || audio !== null;
  if (!anything) {
    const reason = unsupported ?? problems[0] ?? SAFE_REASONS.failed;
    return (await failRun(deps.db, run.id, reason.slice(0, 300), now())) ? "failed" : "lost";
  }

  const analysedShare = prepared.reduce((sum, p) => sum + p.analysedShare, 0) / prepared.length;
  const detections = assembleDetections({
    provider: deps.provider.name,
    frames: results,
    analysedShare,
    transcript,
    audio: audio ? { hasAudio: audio.hasAudio, integratedLufs: audio.integratedLufs, peakDbfs: audio.peakDbfs } : null,
    hasCompanyLogo: Boolean(config.logo),
  });

  // 5. Still allowed, still the same files? Then store.
  if (!(await authorizeRun(deps.db, run, now()))) {
    await cancelRun(deps.db, run.id, SAFE_REASONS.unavailable, now());
    return "cancelled";
  }
  const current = (await listFiles(deps.db, access.sessionId, "ready")).filter((f) => f.kind === "content").slice(0, limits.maxImagesPerRun);
  if (filesFingerprint(current) !== run.files_fingerprint) {
    await cancelRun(deps.db, run.id, SAFE_REASONS.changed, now());
    return "cancelled";
  }
  return (await finishRun(deps.db, run.id, { detections, analysedShare }, now())) ? "done" : "lost";
}
