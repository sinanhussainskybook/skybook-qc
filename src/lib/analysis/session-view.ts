import type { Database } from "@/lib/db/database";
import { countRuns, latestDetections, latestRun, type AnalysisProviderName, type AnalysisRun } from "@/lib/db/analysis-runs";
import type { QcFile } from "@/lib/db/qc-sessions";
import type { ContentDetections } from "@/lib/qc/detections";
import type { AnalysisState } from "@/lib/qc/rules/context";
import { configuredProvider } from "@/lib/analysis/config";
import { ANALYSIS_LIMITS } from "@/lib/analysis/limits";
import { filesFingerprint } from "@/lib/analysis/pipeline";

export type AnalysisView = {
  configured: boolean;
  /** Drives the "not verified" wording in the findings. */
  analysis: AnalysisState;
  /** Detections that apply to the session's CURRENT content, or null. */
  detections: ContentDetections | null;
  /** Which provider produced those detections (the confidence policy adds rules for "local"). */
  provider: AnalysisProviderName | null;
  /** The newest content run (any status), for the progress panel. */
  run: AnalysisRun | null;
  /** The newest information-file run (6.7), for its own panel. */
  informationRun: AnalysisRun | null;
  /** The last result was for different files than the session has now. */
  stale: boolean;
  runsLeft: number;
};

/** What the Start QC page shows about content analysis (read-only). */
export async function loadAnalysisView(db: Database, sessionId: string, contentFiles: QcFile[]): Promise<AnalysisView> {
  const configured = configuredProvider() !== null;
  const [run, informationRun, stored, used] = await Promise.all([
    latestRun(db, sessionId, "content"),
    latestRun(db, sessionId, "information"),
    latestDetections(db, sessionId),
    countRuns(db, sessionId, "content"), // brief readings don't count toward the limit
  ]);
  const current = filesFingerprint(contentFiles.filter((f) => f.status === "ready").slice(0, ANALYSIS_LIMITS.maxImagesPerRun));
  const detections = stored && stored.fingerprint === current ? stored.detections : null;
  const stale = Boolean(stored) && !detections;
  const runsLeft = Math.max(0, ANALYSIS_LIMITS.maxRunsPerSession - used);

  let analysis: AnalysisState;
  if (run && (run.status === "queued" || run.status === "processing")) analysis = { state: "pending" };
  else if (detections) analysis = stored?.analysedShare != null && stored.analysedShare < 1 ? { state: "done", analysedShare: stored.analysedShare } : { state: "done" };
  else if (run?.status === "failed") analysis = { state: "failed", reason: (run.failure_reason ?? "unknown error").replace(/\.$/, "") };
  else if (!configured) analysis = { state: "not_configured" };
  else analysis = { state: "not_started" };
  return { configured, analysis, detections, provider: detections ? (stored?.provider ?? null) : null, run, informationRun, stale, runsLeft };
}
