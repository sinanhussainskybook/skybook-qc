import type { Company, CompanyConfiguration } from "@/lib/company/types";
import type { Database } from "@/lib/db/database";
import { loadCompanyConfiguration } from "@/lib/db/company-config";
import { listFiles, listRequirements, type QcFile, type QcRequirement, type QcSession } from "@/lib/db/qc-sessions";
import { applyConfidencePolicy } from "@/lib/analysis/policy";
import { loadAnalysisView, type AnalysisView } from "@/lib/analysis/session-view";
import { runRules } from "@/lib/qc/engine";
import type { Finding } from "@/lib/qc/findings";
import { consolidateFindings } from "@/lib/qc/consolidate";
import { toQcInput } from "@/lib/qc/qc-input";
import { QC_RULES, qcContextOf } from "@/lib/qc/rules";
import { scoreFindings, type Scoreboard } from "@/lib/qc/scoring";

/**
 * Everything QC knows about the current session, computed fresh each time —
 * the same for the Start QC page and the downloaded report (Phase 8), so
 * both always say the same thing. Nothing here is stored.
 *   findings: Phase 5 rules on the latest detections, after the confidence
 *             policy (6.9), each underlying issue once (lib/qc/consolidate.ts):
 *             checks that found the same issue merged, and one check's
 *             repeats in a design grouped — counted once;
 *             null until content is uploaded;
 *   board:    the Phase 7 result; null until the content has been analysed,
 *             and null while no requirement is confirmed — a PASS with
 *             nothing from the brief to check against would mislead.
 */
export type SessionResult = {
  config: CompanyConfiguration;
  requirements: QcRequirement[];
  files: QcFile[];
  findings: Finding[] | null;
  analysisView: AnalysisView;
  board: Scoreboard | null;
  /** No confirmed requirement: QC has nothing from the client to check against, so there is no result. */
  noRequirements: boolean;
};

export async function loadSessionResult(db: Database, company: Company, session: QcSession): Promise<SessionResult> {
  const [requirements, files, config] = await Promise.all([listRequirements(db, session.id), listFiles(db, session.id, "ready"), loadCompanyConfiguration(db, company)]);
  const content = files.filter((f) => f.kind === "content");
  const analysisView = await loadAnalysisView(db, session.id, content);
  const findings =
    content.length > 0
      ? consolidateFindings(
          applyConfidencePolicy(
            runRules(QC_RULES, session.content_type, {
              ...qcContextOf(toQcInput(config, session, requirements, files), analysisView.detections),
              analysis: analysisView.analysis,
            }),
            analysisView.detections,
            analysisView.analysis,
            { provider: analysisView.provider }
          )
        )
      : null;
  // Phase 7: a result only once the content has been analysed — before that,
  // nothing but the file measurements could have been checked.
  const noRequirements = !requirements.some((r) => r.confirmed);
  const board = findings && analysisView.analysis.state === "done" && !noRequirements ? scoreFindings(findings) : null;
  return { config, requirements, files, findings, analysisView, board, noRequirements };
}
