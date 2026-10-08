import type { Database } from "@/lib/db/database";
import { countRuns, insertRun, latestRun, refreshQueuedFingerprint, type AnalysisRun, type RunKind } from "@/lib/db/analysis-runs";
import { listFiles, type QcFile, type QcSession } from "@/lib/db/qc-sessions";
import { configuredProvider } from "@/lib/analysis/config";
import { ANALYSIS_LIMITS } from "@/lib/analysis/limits";
import { filesFingerprint } from "@/lib/analysis/pipeline";

export const ENQUEUE_MESSAGES = {
  notConfigured: "Content analysis isn't set up on this server.",
  noFiles: { content: "Upload the content first.", information: "Upload an information file first." },
  limit: `This session has used its ${ANALYSIS_LIMITS.maxRunsPerSession} analysis runs. Start over to analyse new content.`,
  active: "An analysis is already running for this session.",
} as const;

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
): Promise<{ ok: true; run: AnalysisRun } | { ok: false; error: string }> {
  const provider = configuredProvider();
  if (!provider) return { ok: false, error: ENQUEUE_MESSAGES.notConfigured };
  const files = await runFiles(db, session.id, kind);
  if (!files.length) return { ok: false, error: ENQUEUE_MESSAGES.noFiles[kind] };
  // The limit is for design analysis only: reading the brief is preparation and never uses it up.
  if (kind === "content" && (await countRuns(db, session.id, "content")) >= ANALYSIS_LIMITS.maxRunsPerSession) {
    return { ok: false, error: ENQUEUE_MESSAGES.limit };
  }
  const run = await insertRun(db, { sessionId: session.id, userId, kind, provider, fingerprint: filesFingerprint(files) }, now);
  return run ? { ok: true, run } : { ok: false, error: ENQUEUE_MESSAGES.active };
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
): Promise<{ ok: true; run: AnalysisRun } | { ok: false; error: string }> {
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
