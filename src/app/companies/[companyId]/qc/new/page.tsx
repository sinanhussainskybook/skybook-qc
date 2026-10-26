import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ClipboardCheck, ScanSearch, TriangleAlert } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { SectionCard } from "@/components/company/section-card";
import { AnalysisPanel } from "@/components/qc/analysis-panel";
import { CategoryChecks } from "@/components/qc/category-checks";
import { CategoryScores, resultWaitingText, Scoreboard } from "@/components/qc/scoreboard";
import { DesignPreviews } from "@/components/qc/design-preview";
import { FILES_BOX_ID, FixedDesignStep } from "@/components/qc/fixed-design-step";
import { FileUploader } from "@/components/qc/file-uploader";
import { GeminiFreeTierNotice } from "@/components/qc/gemini-free-tier-notice";
import { PlatformCheck } from "@/components/qc/platform-check";
import { PlatformForm } from "@/components/qc/platform-form";
import { SessionFooter } from "@/components/qc/session-footer";
import { StartQcButton } from "@/components/qc/start-qc-button";
import { Step } from "@/components/qc/step";
import { requireCompanyAccess } from "@/lib/company/access";
import { getDatabase } from "@/lib/db/client";
import { findCurrentSession } from "@/lib/db/qc-sessions";
import { getUploadLimitBytes } from "@/lib/env";
import { contentMedia } from "@/lib/qc/content-types";
import { missingCompanyInformation } from "@/lib/qc/qc-input";
import { maxFiles } from "@/lib/qc/qc-file";
import { hasExactSize, purgeExpiredSessions, READINESS_MESSAGES, readinessProblems } from "@/lib/qc/session";
import { isCheckable } from "@/lib/qc/requirements";
import { getQcStorage } from "@/lib/storage/qc-storage";
import { loadSessionResult } from "@/lib/qc/session-result";
import { designPreviews } from "@/lib/qc/design-preview";
import { issueMarkers, issuesToFix } from "@/lib/qc/issue-markers";
import type { AnalysisRun } from "@/lib/db/analysis-runs";
import type { AnalysisStatusView } from "@/lib/qc/actions";
import { configuredProvider } from "@/lib/analysis/config";
import { briefChangedSince } from "@/lib/analysis/enqueue";

export const metadata: Metadata = { title: "Start QC · Skybook AI QC" };

/**
 * Start QC — the designer's whole flow on one page:
 *   Start QC → 1. Upload client brief (read automatically) → 2. Upload design
 *   → 3. Check Design → QC result → Download PDF.
 * The requirements read from the brief aren't shown or edited here: Check
 * Design confirms the ones that can be checked (descriptive items never are).
 * The platform is optional, and offered only when the brief gives no exact size.
 * Everything is a temporary session (D11): only this designer can open it,
 * and it is deleted 24 hours after the last change. The design is analysed
 * in the background (the worker); the result is computed fresh from its
 * detections, the same way as the downloaded report.
 */
export default async function StartQcPage({ params }: PageProps<"/companies/[companyId]/qc/new">) {
  const { companyId } = await params;
  const { user, company } = await requireCompanyAccess(companyId);

  const db = getDatabase();
  const storage = getQcStorage();
  const now = new Date();
  // Housekeeping: clear any expired sessions (all companies) before showing this one.
  await purgeExpiredSessions(db, storage, now).catch((error) => console.error("QC clean-up failed:", error));
  const session = await findCurrentSession(db, company.id, user.id, now);

  const back = (
    <Link href={`/companies/${company.id}`} className="hero-glass text-sm">
      <ArrowLeft className="size-4" aria-hidden />
      {company.name}
    </Link>
  );

  if (!session) {
    return (
      <AppShell
        user={user}
        hero={
          <>
            {back}
            <section className="mt-6 flex max-w-2xl flex-col items-center">
              <p className="eyebrow">{company.name}</p>
              <h1 className="display mt-3 text-4xl sm:text-6xl">Start QC</h1>
              <p className="mt-4 mb-8 text-muted-foreground sm:text-lg">
                Upload the client&apos;s brief and the design, then press Check Design. The design is checked against the
                brief and this company&apos;s brand rules.
              </p>
              <StartQcButton companyId={company.id} label="Start QC" className="btn-glossy" />
            </section>
          </>
        }
      />
    );
  }

  // Findings and the result, computed the same way as the downloaded report.
  const { requirements, files, config, findings, analysisView, board, noRequirements } = await loadSessionResult(db, company, session);
  const information = files.filter((f) => f.kind === "information");
  const content = files.filter((f) => f.kind === "content");
  const run = analysisView.run;
  const infoRun = analysisView.informationRun;
  const briefReading = infoRun?.status === "queued" || infoRun?.status === "processing";
  const problems = readinessProblems(requirements, files, session, { briefReading });
  // What the brief gave that can be checked (descriptive items never are). The list itself isn't shown.
  const checkable = requirements.filter(isCheckable);
  // The platform is asked for only when the brief, once read, gives no exact size.
  const askPlatform = Boolean(session.platform) || (!briefReading && checkable.length > 0 && !hasExactSize(checkable));
  const platformFindings = findings && session.platform ? findings.filter((f) => f.category === "platform_size") : null;
  // The result appears once the design has been checked (or is being checked).
  const showResult = Boolean(findings && run);
  const missing = missingCompanyInformation(config);
  const hoursLeft = Math.max(1, Math.ceil((session.expires_at.getTime() - now.getTime()) / 3_600_000));
  const limit = getUploadLimitBytes();
  const view = (list: typeof files) =>
    list.map((f) => ({ id: f.id, file_name: f.file_name, mime_type: f.mime_type, file_size: f.file_size }));
  // Once there's a result, the checked design sits on the left with the files and steps folded under it,
  // and the result takes the main area.
  const compact = showResult;
  const previews = showResult ? await designPreviews(storage, content) : [];
  const markers = board
    ? issueMarkers(issuesToFix(board), analysisView.detections?.texts, content.map((f) => f.id))
    : [];

  const steps = (
    <>
      {/* Before any file can reach Google: only when Gemini is the configured provider. */}
      {configuredProvider() === "gemini" && <GeminiFreeTierNotice />}

      <Step
        id="information"
        n={1}
        compact={compact}
        className={compact ? "border-t-0 pt-0" : "border-t-0 pt-2 sm:pt-2"}
        title="Upload client brief"
        description="The client's brief — a document, an email or a spreadsheet. It's read automatically as soon as it's uploaded."
      >
        <FileUploader
          sessionId={session.id}
          kind="information"
          contentType={session.content_type}
          files={view(information)}
          maxFiles={maxFiles("information", session.content_type)}
          generalLimitBytes={limit}
          storageReady={storage !== null}
          buttonLabel="Upload brief"
        />
        {information.length > 0 && (
          <div className="mt-4 border-t pt-4">
            <AnalysisPanel
              key={infoRun ? `${infoRun.id}-${infoRun.status}` : "none"}
              kind="information"
              sessionId={session.id}
              configured={analysisView.configured}
              hasContent
              stale={infoRun?.status === "done" && briefChangedSince(infoRun, files)}
              found={checkable.length}
              initial={statusOf(infoRun)}
            />
          </div>
        )}
      </Step>

      <Step
        id="content"
        n={2}
        compact={compact}
        title="Upload design"
        description={
          contentMedia(session.content_type) === "video"
            ? "The video you want checked."
            : "The design you want checked. Several images are fine, e.g. a carousel."
        }
      >
        <FileUploader
          sessionId={session.id}
          kind="content"
          contentType={session.content_type}
          files={view(content)}
          maxFiles={maxFiles("content", session.content_type)}
          generalLimitBytes={limit}
          storageReady={storage !== null}
          buttonLabel="Upload design"
        />
      </Step>

      {askPlatform && (
        <Step
          id="platform"
          compact={compact}
          title="Platform (optional)"
          description="Optional: choose where the design will be published to also check its size, ratio, format and file size against that platform's published specification. Without a platform, all the other checks still run and the platform checks are shown as not checked."
        >
          <PlatformForm
            key={`${session.content_type}-${session.platform ?? ""}-${session.placement ?? ""}`}
            sessionId={session.id}
            media={contentMedia(session.content_type)}
            current={{
              platform: session.platform,
              placement: session.placement,
              customLabel: session.custom_label,
              customWidth: session.custom_width,
              customHeight: session.custom_height,
              customUnit: session.custom_unit,
              customMinDpi: session.custom_min_dpi,
              customMaxBytes: session.custom_max_bytes,
            }}
          />
        </Step>
      )}

      <Step id="check" n={3} compact={compact} title="Check design" description="The design is compared with the brief and the company's brand rules.">
        <div className="space-y-4">
          <SessionFooter sessionId={session.id} status={session.status} problems={problems} />
          {run && (
            <div className="border-t pt-4">
              <AnalysisPanel
                key={`${run.id}-${run.status}`}
                sessionId={session.id}
                configured={analysisView.configured}
                hasContent={content.length > 0}
                stale={analysisView.stale}
                runsLeft={analysisView.runsLeft}
                initial={statusOf(run)}
              />
            </div>
          )}
        </div>
      </Step>
    </>
  );

  const missingNote = missing.length > 0 && (
    <p className="mt-6 flex items-start gap-2 border-t border-border pt-6 text-sm text-muted-foreground">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-revision" aria-hidden />
      <span>
        This company has no {missing.join(", ")} saved yet. Checks that need them will show as <strong>not verified</strong> when QC
        runs.{" "}
        <Link href={`/companies/${company.id}`} className="font-medium text-primary hover:underline">
          Add them on the company page
        </Link>
        .
      </span>
    </p>
  );

  return (
    <AppShell
      user={user}
      wide={showResult}
      hero={
        <>
          {back}
          <header className="mt-6">
            <p className="eyebrow">{company.name}</p>
            <h1 className="display mt-3 text-4xl sm:text-6xl">Start QC</h1>
            <p className="mt-4 text-sm text-muted-foreground">
              Deleted automatically in {hoursLeft} hour{hoursLeft === 1 ? "" : "s"} unless you make a change.
            </p>
          </header>
        </>
      }
    >
      {!storage && (
        <p className="mb-6 flex items-start gap-2 rounded-xl bg-revision-soft px-4 py-3 text-sm text-revision">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          File storage isn&apos;t set up on this server yet, so files can&apos;t be uploaded. Ask your administrator.
        </p>
      )}

      {showResult ? (
        <div className="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)] lg:gap-8">
          {/* The result first on phones; on wide screens the design sits on the left, beside the result. */}
          <aside
            aria-label="Checked design and files"
            className="order-last space-y-4 lg:order-none lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7rem)] lg:self-start lg:overflow-y-auto"
          >
            <DesignPreviews previews={previews} markers={markers} />
            {/* Open while the check is running or out of date, so its progress and Check again stay in view. */}
            <details id={FILES_BOX_ID} className="group scroll-mt-24 rounded-2xl bg-card shadow-sm ring-1 ring-border" open={!board || analysisView.stale}>
              <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">Files and Check Design</span>
                  <span className="block text-xs text-muted-foreground">Change the brief or the design, or check again.</span>
                </span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="border-t border-border p-4">{steps}</div>
            </details>
          </aside>
          <div className="min-w-0 rounded-2xl bg-card p-5 shadow-sm ring-1 ring-border sm:p-6">
            <section id="qc-result" aria-label="QC result" className="scroll-mt-24 pb-8">
              {noRequirements ? (
                <p className="rounded-xl bg-revision-soft px-4 py-3 text-sm font-medium text-revision">{READINESS_MESSAGES.requirements}</p>
              ) : board ? (
                <Scoreboard
                  board={board}
                  findings={findings!}
                  mock={analysisView.detections?.source === "mock"}
                  reportHref={`/companies/${company.id}/qc/report`}
                  nextStep={<FixedDesignStep />}
                />
              ) : (
                <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">{resultWaitingText(analysisView.analysis.state)}</p>
              )}
            </section>

            <details id="all-checks" className="group border-t border-border py-6">
              <summary className="flex cursor-pointer list-none items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-lg font-semibold tracking-tight">All checks in detail</span>
                  <span className="block text-sm text-muted-foreground">Every check with its full explanation, score by category, and anything that couldn&apos;t be checked.</span>
                </span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="mt-6 space-y-4">
                {board && (
                  <section aria-label="Score by category">
                    <CategoryScores board={board} />
                  </section>
                )}
                {platformFindings && (
                  <SectionCard
                    id="platform-check"
                    title="Platform check"
                    description="Measured from the uploaded content. Safe zones and anything that couldn't be measured are shown as not verified, never guessed."
                    icon={ScanSearch}
                  >
                    <PlatformCheck findings={platformFindings} />
                  </SectionCard>
                )}
                <SectionCard
                  id="content-checks"
                  title="Content checks"
                  description="Content, brand, Golden Rules, layout, accessibility, image, brief and legal checks for this session."
                  icon={ClipboardCheck}
                >
                  <CategoryChecks
                    findings={findings!}
                    analysis={analysisView.analysis}
                    mock={analysisView.detections?.source === "mock"}
                    local={analysisView.provider === "local"}
                    gemini={analysisView.provider === "gemini"}
                  />
                </SectionCard>
              </div>
            </details>

            {missingNote}
          </div>
        </div>
      ) : (
        <div>
          {steps}
          {missingNote}
        </div>
      )}
    </AppShell>
  );
}

function statusOf(run: AnalysisRun | null): AnalysisStatusView | null {
  return run
    ? {
        id: run.id,
        kind: run.kind,
        status: run.status,
        stage: run.stage,
        done: run.progress_done,
        total: run.progress_total,
        reason: run.failure_reason,
        mock: run.provider === "mock",
        provider: run.provider,
      }
    : null;
}
