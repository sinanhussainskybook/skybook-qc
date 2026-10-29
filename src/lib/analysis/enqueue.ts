import type { Database } from "@/lib/db/database";
import { randomUUID } from "node:crypto";
import {
  countRuns,
  hasActiveRun,
  insertRun,
  latestRun,
  refreshQueuedFingerprint,
  type AnalysisRun,
  type RunKind,
} from "@/lib/db/analysis-runs";
import { analysisUsage, cancelAnalysisReservation, releaseAnalysisSlot, reserveAnalysis } from "@/lib/db/analysis-usage";
import { listFiles, type QcFile, type QcSession } from "@/lib/db/qc-sessions";
import { configuredProvider } from "@/lib/analysis/config";
import { ANALYSIS_LIMITS } from "@/lib/analysis/limits";
import { filesFingerprint } from "@/lib/analysis/pipeline";

export const ENQUEUE_MESSAGES = {
  notConfigured: "Content analysis isn't set up on this server.",
  noFiles: { content: "Upload the content first.", information: "Upload an information file first." },
  limit: `This session has used its ${ANALYSIS_LIMITS.maxRunsPerSession} analysis runs. Start over to analyse new content.`,
  active: "An analysis is already running for this session.",
  userActive: `You already have ${ANALYSIS_LIMITS.maxActiveRunsPerUser} AI checks waiting or running. Wait for one to finish, then try again.`,
} as const;

/** The per-user 24-hour limit, with roughly when the next check becomes possible. */
export function dailyLimitMessage(oldest: Date | null, now: Date): string {
  const hours = oldest ? Math.max(1, Math.ceil((oldest.getTime() + 24 * 60 * 60 * 1000 - now.getTime()) / (60 * 60 * 1000))) : 24;
  return `You've used your ${ANALYSIS_LIMITS.maxRunsPerUserPerDay} AI checks for the last 24 hours (design checks and brief readings together). You can start another in about ${hours} hour${hours === 1 ? "" : "s"}, or ask an admin.`;
}

/** A refusal: `limited` when it's one of the per-user limits (the page shows it as it is). */
export type EnqueueResult = { ok: true; run: AnalysisRun } | { ok: false; error: string; limited?: boolean };

/**
 * Queues an analysis run for a session the caller has ALREADY checked the
 * user may use (lib/qc/access.ts). The worker checks again before and after.
 */
export async function enqueueRun(
  db: Database,
  session: QcSession,
  userId: string,
  kind: RunKind,
  now: Date
): Promise<EnqueueResult> {
  const provider = configuredProvider();
  if (!provider) return { ok: false, error: ENQUEUE_MESSAGES.notConfigured };
  const files = await runFiles(db, session.id, kind);
  if (!files.length) return { ok: false, error: ENQUEUE_MESSAGES.noFiles[kind] };
  // The limit is for design analysis only: reading the brief is preparation and never uses it up.
  if (kind === "content" && (await countRuns(db, session.id, "content")) >= ANALYSIS_LIMITS.maxRunsPerSession) {
    return { ok: false, error: ENQUEUE_MESSAGES.limit };
  }
  // One run at a time per session (insertRun enforces it too): said before any place is reserved.
  if (await hasActiveRun(db, session.id)) return { ok: false, error: ENQUEUE_MESSAGES.active };

  // The per-user limits are checked BEFORE the run is queued, so the worker never sees a run that could
  // still be refused. A place is reserved first and then counted: of two requests at the same moment
  // (any web instance, any connection) the later one always sees the earlier, so neither can slip past a
  // limit — at worst both are refused. A refused or failed reservation is taken back off the count.
  const reservation = randomUUID();
  await reserveAnalysis(db, userId, reservation, now);
  try {
    const usage = await analysisUsage(db, userId, now);
    const refusal =
      usage.today > ANALYSIS_LIMITS.maxRunsPerUserPerDay
        ? dailyLimitMessage(usage.oldest, now)
        : usage.active > ANALYSIS_LIMITS.maxActiveRunsPerUser
          ? ENQUEUE_MESSAGES.userActive
          : null;
    if (refusal) {
      await cancelAnalysisReservation(db, userId, reservation);
      return { ok: false, error: refusal, limited: true };
    }
    const run = await insertRun(db, { sessionId: session.id, userId, kind, provider, fingerprint: filesFingerprint(files) }, now);
    if (!run) {
      await cancelAnalysisReservation(db, userId, reservation);
      return { ok: false, error: ENQUEUE_MESSAGES.active };
    }
    // The queued run now counts as waiting itself; the reservation stays in the 24-hour count.
    await releaseAnalysisSlot(db, userId, reservation).catch(() => {}); // if this fails, the place frees itself in 2 minutes
    return { ok: true, run };
  } catch (error) {
    await cancelAnalysisReservation(db, userId, reservation).catch(() => {});
    throw error;
  }
}

const runFiles = async (db: Database, sessionId: string, kind: RunKind) =>
  (await listFiles(db, sessionId, "ready")).filter((f) => f.kind === kind).slice(0, ANALYSIS_LIMITS.maxImagesPerRun);

/**
 * Reading the brief starts by itself when an information file is uploaded.
 * If a reading is already waiting to start (several files uploaded together),
 * that one takes in the new file instead of a second run being queued.
 */
export async function enqueueBriefReading(
  db: Database,
  session: QcSession,
  userId: string,
  now: Date
): Promise<EnqueueResult> {
  const queued = await enqueueRun(db, session, userId, "information", now);
  if (queued.ok || queued.error !== ENQUEUE_MESSAGES.active) return queued;
  const waiting = await latestRun(db, session.id, "information");
  if (waiting?.status === "queued" && (await refreshQueuedFingerprint(db, waiting.id, filesFingerprint(await runFiles(db, session.id, "information"))))) {
    return { ok: true, run: waiting };
  }
  return queued;
}

/** Has an information file been added or removed since this brief reading? */
export function briefChangedSince(run: Pick<AnalysisRun, "files_fingerprint">, files: Pick<QcFile, "id" | "file_size" | "kind" | "status">[]): boolean {
  const information = files.filter((f) => f.kind === "information" && f.status === "ready").slice(0, ANALYSIS_LIMITS.maxImagesPerRun);
  return filesFingerprint(information) !== run.files_fingerprint;
}
