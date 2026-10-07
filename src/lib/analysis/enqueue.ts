import type { Database } from "@/lib/db/database";
import { countRuns, insertRun, type AnalysisRun, type RunKind } from "@/lib/db/analysis-runs";
import { listFiles, type QcSession } from "@/lib/db/qc-sessions";
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
  const files = (await listFiles(db, session.id, "ready")).filter((f) => f.kind === kind).slice(0, ANALYSIS_LIMITS.maxImagesPerRun);
  if (!files.length) return { ok: false, error: ENQUEUE_MESSAGES.noFiles[kind] };
  if ((await countRuns(db, session.id)) >= ANALYSIS_LIMITS.maxRunsPerSession) return { ok: false, error: ENQUEUE_MESSAGES.limit };
  const run = await insertRun(db, { sessionId: session.id, userId, kind, provider, fingerprint: filesFingerprint(files) }, now);
  return run ? { ok: true, run } : { ok: false, error: ENQUEUE_MESSAGES.active };
}
