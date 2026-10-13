import { getCurrentUser } from "@/lib/auth/current-user";
import { findCompanyForUser } from "@/lib/company/access";
import { getDatabase } from "@/lib/db/client";
import { findCurrentSession } from "@/lib/db/qc-sessions";
import { loadSessionResult } from "@/lib/qc/session-result";
import { READINESS_MESSAGES } from "@/lib/qc/session";
import { buildReportData } from "@/lib/report/report-data";
import { logoForReport } from "@/lib/report/report-logo";
import { renderReportPdf, reportFileName } from "@/lib/report/report-pdf";
import { readStorageConfig } from "@/lib/storage/logo-storage";
import { createBucketClient } from "@/lib/storage/storage-api";

/**
 * GET /companies/[companyId]/qc/report — the QC report (Phase 8) as a PDF,
 * built from the designer's CURRENT session on each download. Only the
 * session's owner can download it (same checks as the Start QC page). The
 * report is never stored: no database row, no file, no history — the
 * download is the only copy.
 */
export const dynamic = "force-dynamic";

const plain = (status: number, message: string) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export async function GET(_request: Request, { params }: RouteContext<"/companies/[companyId]/qc/report">) {
  const user = await getCurrentUser();
  if (!user) return plain(401, "Sign in to download the QC report.");
  // A temporary password (set by an administrator) must be changed first, as on every page.
  if (user.mustChangePassword) return plain(403, "Choose your new password first, then download the report.");
  const { companyId } = await params;
  const company = await findCompanyForUser(user, companyId);
  if (!company) return plain(404, "Not found.");

  const db = getDatabase();
  const now = new Date();
  const session = await findCurrentSession(db, company.id, user.id, now);
  if (!session) return plain(404, "There is no QC session for this company.");

  const result = await loadSessionResult(db, company, session);
  if (result.noRequirements) return plain(409, READINESS_MESSAGES.requirements);
  if (!result.findings || !result.board) return plain(409, "There is no QC result yet: upload the content and let it be analysed first.");

  // The saved logo, read on the server from the private bucket; any problem → name only.
  let logoBytes: Uint8Array | null = null;
  const storageConfig = readStorageConfig();
  if (result.config.logo && storageConfig) {
    const stored = await createBucketClient(storageConfig, storageConfig.bucket)
      .readStart(result.config.logo.storage_path, result.config.logo.file_size + 1)
      .catch(() => null);
    logoBytes = stored?.bytes ?? null;
  }

  try {
    const data = buildReportData({
      config: result.config,
      session,
      requirements: result.requirements,
      files: result.files,
      findings: result.findings,
      board: result.board,
      sampleData: result.analysisView.detections?.source === "mock",
      provider: result.analysisView.provider,
      generatedAt: now,
      timeZone: process.env.QC_REPORT_TIME_ZONE?.trim() || "Asia/Dubai",
    });
    const pdf = await renderReportPdf(data, await logoForReport(logoBytes));
    return new Response(Buffer.from(pdf.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${reportFileName(company.name, now)}"`,
        "Content-Length": String(pdf.bytes.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("QC report failed:", error instanceof Error ? error.name : "error");
    return plain(500, "The QC report couldn't be created. Try again.");
  }
}
