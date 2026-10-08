import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ClipboardCheck, Clock, FileUp, Gauge, ListChecks, Ruler, ScanSearch, Sparkles, TriangleAlert, Upload } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { SectionCard } from "@/components/company/section-card";
import { ContentTypeForm } from "@/components/qc/content-type-form";
import { AnalysisPanel } from "@/components/qc/analysis-panel";
import { CategoryChecks } from "@/components/qc/category-checks";
import { CategoryScores, resultWaitingText, Scoreboard } from "@/components/qc/scoreboard";
import { FileUploader } from "@/components/qc/file-uploader";
import { GeminiFreeTierNotice } from "@/components/qc/gemini-free-tier-notice";
import { PlatformCheck } from "@/components/qc/platform-check";
import { PlatformForm } from "@/components/qc/platform-form";
import { RequirementsEditor } from "@/components/qc/requirements-editor";
import { SessionFooter } from "@/components/qc/session-footer";
import { Badge } from "@/components/ui/badge";
import { requireCompanyAccess } from "@/lib/company/access";
import { getDatabase } from "@/lib/db/client";
import { findCurrentSession } from "@/lib/db/qc-sessions";
import { getUploadLimitBytes } from "@/lib/env";
import { contentMedia, contentTypeLabel } from "@/lib/qc/content-types";
import { missingCompanyInformation } from "@/lib/qc/qc-input";
import { maxFiles } from "@/lib/qc/qc-file";
import { purgeExpiredSessions, READINESS_MESSAGES, readinessProblems } from "@/lib/qc/session";
import { getQcStorage } from "@/lib/storage/qc-storage";
import { loadSessionResult } from "@/lib/qc/session-result";
import type { AnalysisRun } from "@/lib/db/analysis-runs";
import type { AnalysisStatusView } from "@/lib/qc/actions";
import { configuredProvider } from "@/lib/analysis/config";
import { briefChangedSince } from "@/lib/analysis/enqueue";

export const metadata: Metadata = { title: "Start QC · Skybook AI QC" };

/**
 * Phase 4 — Requirements + Upload. One page: what am I checking, what did
 * the client ask for, what supporting information do I have, what content
 * am I submitting. Everything here is a temporary session (D11): only this
 * designer can open it, and it is deleted 24 hours after the last change.
 * Phase 5 adds the platform choice and the QC engine; Phase 6 adds content
 * analysis: saving queues a background run (the worker), its progress shows
 * here, and its validated detections feed every rule. Without them checks
 * show as "not verified" with the reason. The QC result (Phase 7) is shown once
 * the content has been analysed.
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
    <Link
      href={`/companies/${company.id}`}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {company.name}
    </Link>
  );

  if (!session) {
    return (
      <AppShell user={user}>
        {back}
        <section className="mx-auto mt-8 max-w-2xl rounded-3xl bg-card p-6 ring-1 ring-foreground/8 sm:p-8">
          <p className="text-sm font-medium text-muted-foreground">{company.name}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Start QC</h1>
          <p className="mt-2 mb-6 text-sm text-muted-foreground">
            What are you checking? You&apos;ll add the client&apos;s requirements and upload the content next.
          </p>
          <ContentTypeForm mode="start" companyId={company.id} />
        </section>
      </AppShell>
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
  const platformFindings = findings && session.platform ? findings.filter((f) => f.category === "platform_size") : null;
  const missing = missingCompanyInformation(config);
  const hoursLeft = Math.max(1, Math.ceil((session.expires_at.getTime() - now.getTime()) / 3_600_000));
  const limit = getUploadLimitBytes();
  const view = (list: typeof files) =>
    list.map((f) => ({ id: f.id, file_name: f.file_name, mime_type: f.mime_type, file_size: f.file_size }));

  return (
    <AppShell user={user}>
      {back}

      <header className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Start QC</h1>
            {session.status === "ready" ? (
              <Badge className="bg-pass-soft text-pass">Ready</Badge>
            ) : (
              <Badge variant="outline">Draft</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {company.name} · {contentTypeLabel(session.content_type)}
          </p>
        </div>
        <p className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5" aria-hidden />
          Deleted automatically in {hoursLeft} hour{hoursLeft === 1 ? "" : "s"} unless you make a change
        </p>
      </header>

      {!storage && (
        <p className="mt-5 flex items-start gap-2 rounded-xl bg-revision-soft px-4 py-3 text-sm text-revision">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          File storage isn&apos;t set up on this server yet, so files can&apos;t be uploaded. Ask your administrator.
        </p>
      )}

      <div className="mt-6 space-y-6">
        <SectionCard id="content-type" title="1. What are you checking?" icon={FileUp}>
          <ContentTypeForm mode="change" companyId={company.id} sessionId={session.id} current={session.content_type} />
        </SectionCard>

        <SectionCard
          id="platform"
          title="2. Platform"
          description="Where the content will be published. Its size, ratio, format, file size and length are checked against that platform's published specification."
          icon={Ruler}
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
        </SectionCard>

        <SectionCard
          id="requirements"
          title="3. Requirements"
          description="What the client asked for — read from the brief you upload in step 4, or added by hand. Check the list, edit or remove anything that's wrong, then press Confirm & Run QC."
          icon={ListChecks}
        >
          <RequirementsEditor
            sessionId={session.id}
            requirements={requirements.map((r) => ({
              id: r.id,
              type: r.type,
              label: r.label,
              expected_value: r.expected_value,
              notes: r.notes,
              mandatory: r.mandatory,
              confirmed: r.confirmed,
              source: r.source,
            }))}
          />
        </SectionCard>

        {/* Before any file can reach Google: only when Gemini is the configured provider. */}
        {configuredProvider() === "gemini" && <GeminiFreeTierNotice />}

        <SectionCard
          id="information"
          title="4. Upload Information"
          description="The client's brief — a document, an email, a spreadsheet. It's read as soon as it's uploaded, and what it asks for is listed under Requirements for you to check."
          icon={Upload}
        >
          <FileUploader
            sessionId={session.id}
            kind="information"
            contentType={session.content_type}
            files={view(information)}
            maxFiles={maxFiles("information", session.content_type)}
            generalLimitBytes={limit}
            storageReady={storage !== null}
            buttonLabel="Upload information"
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
                initial={statusOf(infoRun)}
              />
            </div>
          )}
        </SectionCard>

        <SectionCard
          id="content"
          title="5. Upload Content"
          description={
            contentMedia(session.content_type) === "video"
              ? "The video you want checked."
              : "The design you want checked. Several images are fine, e.g. a carousel."
          }
          icon={Upload}
        >
          <FileUploader
            sessionId={session.id}
            kind="content"
            contentType={session.content_type}
            files={view(content)}
            maxFiles={maxFiles("content", session.content_type)}
            generalLimitBytes={limit}
            storageReady={storage !== null}
            buttonLabel="Upload content"
          />
        </SectionCard>

        <SectionCard
          id="analysis"
          title="6. Analysis"
          description="The design is read in the background — text, colours, logo and images. Results feed the checks below."
          icon={Sparkles}
        >
          <AnalysisPanel
            key={run ? `${run.id}-${run.status}` : "none"}
            sessionId={session.id}
            configured={analysisView.configured}
            hasContent={content.length > 0}
            stale={analysisView.stale}
            runsLeft={analysisView.runsLeft}
            initial={statusOf(run)}
          />
        </SectionCard>

        {findings && (
          <SectionCard
            id="qc-result"
            title="QC result"
            description="What's wrong, how serious it is, and how to fix it."
            icon={Gauge}
          >
            {noRequirements ? (
              <p className="rounded-xl bg-revision-soft px-4 py-3 text-sm font-medium text-revision">{READINESS_MESSAGES.requirements}</p>
            ) : board ? (
              <Scoreboard board={board} findings={findings} mock={analysisView.detections?.source === "mock"} reportHref={`/companies/${company.id}/qc/report`} />
            ) : (
              <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">{resultWaitingText(analysisView.analysis.state)}</p>
            )}
          </SectionCard>
        )}

        {findings && (
          <details id="all-checks" className="group rounded-2xl bg-card ring-1 ring-foreground/8">
            <summary className="flex cursor-pointer list-none items-center gap-3 p-5 sm:px-7">
              <ListChecks className="size-4.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-semibold tracking-tight">All checks in detail</span>
                <span className="block text-sm text-muted-foreground">Every check with its full explanation, score by category, and anything that couldn&apos;t be checked.</span>
              </span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <div className="space-y-4 px-3 pb-3 sm:px-4 sm:pb-4">
              {board && (
                <section aria-label="Score by category" className="px-2 sm:px-3">
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

            {findings && (
              <SectionCard
                id="content-checks"
                title="Content checks"
                description="Content, brand, Golden Rules, layout, accessibility, image, brief and legal checks for this session."
                icon={ClipboardCheck}
              >
                <CategoryChecks
                  findings={findings}
                  analysis={analysisView.analysis}
                  mock={analysisView.detections?.source === "mock"}
                  local={analysisView.provider === "local"}
                  gemini={analysisView.provider === "gemini"}
                />
              </SectionCard>
            )}
            </div>
          </details>
        )}

        {missing.length > 0 && (
          <p className="flex items-start gap-2 rounded-xl bg-revision-soft px-4 py-3 text-sm text-foreground">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-revision" aria-hidden />
            <span>
              This company has no {missing.join(", ")} saved yet. Checks that need them will show as{" "}
              <strong>not verified</strong> when QC runs.{" "}
              <Link href={`/companies/${company.id}`} className="font-medium text-primary hover:underline">
                Add them on the company page
              </Link>
              .
            </span>
          </p>
        )}

        <section className="rounded-2xl bg-card p-5 ring-1 ring-foreground/8 sm:p-7" aria-label="Save">
          <SessionFooter sessionId={session.id} status={session.status} problems={problems} />
        </section>
      </div>
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
