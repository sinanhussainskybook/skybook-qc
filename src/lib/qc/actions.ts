"use server";

import { revalidatePath } from "next/cache";
import { getDatabase } from "@/lib/db/client";
import {
  deleteRequirement,
  findCurrentSession,
  insertRequirement,
  listFiles,
  listRequirements,
  setRequirementConfirmed,
  setSessionPlatform,
  touchSession,
  updateRequirement,
} from "@/lib/db/qc-sessions";
import { getUploadLimitBytes } from "@/lib/env";
import { requireUser } from "@/lib/auth/current-user";
import { findCompanyForUser } from "@/lib/company/access";
import { isUuid } from "@/lib/company/validation";
import { findSessionForUser } from "@/lib/qc/access";
import { isOfferedContentType } from "@/lib/qc/content-types";
import { checkRequirement } from "@/lib/qc/requirements";
import { parsePlatformChoice } from "@/lib/qc/platform-choice";
import {
  changeContentType,
  confirmUpload,
  markReady,
  prepareUpload,
  READINESS_MESSAGES,
  removeFile,
  removeSessionCompletely,
  startSession,
  type PrepareResult,
} from "@/lib/qc/session";
import type { FileKind } from "@/lib/qc/qc-file";
import { getQcStorage } from "@/lib/storage/qc-storage";
import { enqueueBriefReading, enqueueRun } from "@/lib/analysis/enqueue";
import { hasFinishedDesignCheck, latestRun, type RunKind, type RunStatus } from "@/lib/db/analysis-runs";

/**
 * Server actions for the Start QC page (Phase 4). Every one:
 *   1. requires a signed-in user,
 *   2. checks the company (D13) and — once a session exists — that it
 *      belongs to this user and hasn't expired (lib/qc/access.ts),
 *   3. checks every value on the server,
 *   4. changes only that session.
 * Messages are plain; details go to the server log.
 */

export type QcFormState = {
  ok?: boolean;
  message?: string;
  error?: string;
  errors?: Record<string, string>;
  /** Start a QC check found this designer's COMPLETED check for the company: confirm, then start fresh. */
  confirmNewCheck?: { sessionId: string };
};

const MESSAGES = {
  notAvailable: "This QC session isn't available any more. Reload the page.",
  companyNotAvailable: "This company isn't available. Reload the page and try again.",
  storageNotConfigured: "File storage isn't set up on this server yet. Ask your administrator.",
  failed: "That couldn't be saved. Please try again.",
  contentType: "Choose what you're checking.",
};

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function refresh(companyId: string) {
  revalidatePath(`/companies/${companyId}/qc/new`);
}

async function sessionFromForm(formData: FormData) {
  return findSessionForUser(formData.get("sessionId"));
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Start a QC check. An unfinished check (nothing checked to the end yet) is opened again, within its 24
 * hours. A COMPLETED check — its design checked, a result shown — is never reopened: the designer is asked
 * to confirm, and startNewCheckAction then removes it (files first) and starts an empty one.
 */
export async function startSessionAction(_previous: QcFormState, formData: FormData): Promise<QcFormState> {
  const user = await requireUser();
  const company = await findCompanyForUser(user, formData.get("companyId"));
  if (!company) return { error: MESSAGES.companyNotAvailable };
  const contentType = field(formData, "contentType");
  if (!isOfferedContentType(contentType)) return { error: MESSAGES.contentType };

  try {
    const current = await findCurrentSession(getDatabase(), company.id, user.id, new Date());
    if (current && (await hasFinishedDesignCheck(getDatabase(), current.id))) {
      return { confirmNewCheck: { sessionId: current.id } };
    }
    await startSession(getDatabase(), getQcStorage(), { companyId: company.id, userId: user.id, contentType }, new Date());
  } catch (error) {
    console.error("Starting a QC session failed:", error);
    return { error: MESSAGES.failed };
  }
  refresh(company.id);
  return { ok: true };
}

/** Deletes the current session — requirements, file records and files — so the designer can begin again. */
export async function startOverAction(_previous: QcFormState, formData: FormData): Promise<QcFormState> {
  const found = await sessionFromForm(formData);
  if (!found) return { error: MESSAGES.notAvailable };
  const removed = await removeSessionCompletely(getDatabase(), getQcStorage(), found.session.id);
  if (!removed) return { error: "The session couldn't be cleared right now. Please try again in a moment." };
  refresh(found.company.id);
  return { ok: true };
}

/**
 * "Start a new check" (after confirming, when the last check is complete): Start over for THIS company's
 * current session (its files, then its records — startOverAction), then a fresh, empty session
 * (startSessionAction). The session must be the signed-in designer's own, for the company named in the
 * form; anything else changes nothing.
 */
export async function startNewCheckAction(previous: QcFormState, formData: FormData): Promise<QcFormState> {
  const found = await sessionFromForm(formData);
  if (!found || found.company.id !== field(formData, "companyId")) return { error: MESSAGES.notAvailable };
  const cleared = await startOverAction(previous, formData);
  if (!cleared.ok) return cleared;
  return startSessionAction(previous, formData);
}

export async function changeContentTypeAction(_previous: QcFormState, formData: FormData): Promise<QcFormState> {
  const found = await sessionFromForm(formData);
  if (!found) return { error: MESSAGES.notAvailable };
  const contentType = field(formData, "contentType");
  if (!isOfferedContentType(contentType)) return { error: MESSAGES.contentType };

  const result = await changeContentType(getDatabase(), found.session, contentType, new Date());
  if (!result.ok) return { error: result.error };
  refresh(found.company.id);
  return { ok: true };
}

/** Sets the platform / placement (or a typed size) the content is for (Phase 5, D4). */
export async function setPlatformAction(_previous: QcFormState, formData: FormData): Promise<QcFormState> {
  const found = await sessionFromForm(formData);
  if (!found) return { error: MESSAGES.notAvailable };
  const choice = parsePlatformChoice(
    {
      platform: field(formData, "platform"),
      placement: field(formData, "placement"),
      label: field(formData, "customLabel"),
      width: field(formData, "customWidth"),
      height: field(formData, "customHeight"),
      unit: field(formData, "customUnit"),
      minDpi: field(formData, "customMinDpi"),
      maxMb: field(formData, "customMaxMb"),
    },
    found.session.content_type
  );
  if (!choice.ok) return { error: choice.error };
  try {
    await setSessionPlatform(getDatabase(), found.session.id, choice.value, new Date());
  } catch (error) {
    console.error("Saving the QC platform failed:", error);
    return { error: MESSAGES.failed };
  }
  refresh(found.company.id);
  return { ok: true, message: "Platform saved." };
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

/** Adds a requirement, or edits it when the form has a requirementId. */
export async function saveRequirementAction(_previous: QcFormState, formData: FormData): Promise<QcFormState> {
  const found = await sessionFromForm(formData);
  if (!found) return { error: MESSAGES.notAvailable };
  const requirementId = field(formData, "requirementId");
  if (requirementId && !isUuid(requirementId)) return { error: MESSAGES.notAvailable };

  const checked = checkRequirement((name) => field(formData, name));
  if (!checked.ok) return { errors: checked.errors };

  const db = getDatabase();
  const now = new Date();
  try {
    if (requirementId) {
      if (!(await updateRequirement(db, found.session.id, requirementId, checked.value, now))) {
        return { error: MESSAGES.notAvailable };
      }
    } else {
      await insertRequirement(db, found.session.id, checked.value, now);
    }
    await touchSession(db, found.session.id, now);
  } catch (error) {
    console.error("Saving a requirement failed:", error);
    return { error: MESSAGES.failed };
  }
  refresh(found.company.id);
  return { ok: true };
}

export async function setRequirementConfirmedAction(_previous: QcFormState, formData: FormData): Promise<QcFormState> {
  const found = await sessionFromForm(formData);
  const requirementId = field(formData, "requirementId");
  const confirmed = field(formData, "confirmed");
  if (!found || !isUuid(requirementId) || (confirmed !== "true" && confirmed !== "false")) {
    return { error: MESSAGES.notAvailable };
  }
  const db = getDatabase();
  const now = new Date();
  if (!(await setRequirementConfirmed(db, found.session.id, requirementId, confirmed === "true", now))) {
    return { error: MESSAGES.notAvailable };
  }
  await touchSession(db, found.session.id, now);
  refresh(found.company.id);
  return { ok: true };
}

export async function deleteRequirementAction(_previous: QcFormState, formData: FormData): Promise<QcFormState> {
  const found = await sessionFromForm(formData);
  const requirementId = field(formData, "requirementId");
  if (!found || !isUuid(requirementId)) return { error: MESSAGES.notAvailable };
  const db = getDatabase();
  if (!(await deleteRequirement(db, found.session.id, requirementId))) return { error: MESSAGES.notAvailable };
  await touchSession(db, found.session.id, new Date());
  refresh(found.company.id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Files — called from the upload component with plain values
// ---------------------------------------------------------------------------

/** Step 1: checks the request and returns a one-time upload link for a path chosen here. */
export async function prepareUploadAction(input: {
  sessionId: string;
  kind: FileKind;
  name: string;
  size: number;
  type: string;
}): Promise<PrepareResult> {
  const found = await findSessionForUser(input?.sessionId);
  if (!found) return { ok: false, error: MESSAGES.notAvailable };
  if (input.kind !== "information" && input.kind !== "content") return { ok: false, error: MESSAGES.notAvailable };
  const storage = getQcStorage();
  if (!storage) return { ok: false, error: MESSAGES.storageNotConfigured };

  try {
    return await prepareUpload(
      getDatabase(),
      storage,
      found.session,
      { kind: input.kind, name: String(input.name ?? ""), size: Number(input.size), type: String(input.type ?? "") },
      getUploadLimitBytes(),
      new Date()
    );
  } catch (error) {
    console.error("Preparing an upload failed:", error);
    return { ok: false, error: MESSAGES.failed };
  }
}

/**
 * Step 2: checks what actually arrived; a file that fails is deleted. An
 * information file (the brief) is then read straight away: what it asks for
 * appears under Requirements for the designer to review.
 */
export async function confirmUploadAction(input: {
  sessionId: string;
  fileId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const found = await findSessionForUser(input?.sessionId);
  if (!found || !isUuid(input.fileId)) return { ok: false, error: MESSAGES.notAvailable };
  const storage = getQcStorage();
  if (!storage) return { ok: false, error: MESSAGES.storageNotConfigured };

  const db = getDatabase();
  const now = new Date();
  const result = await confirmUpload(db, storage, found.session, input.fileId, getUploadLimitBytes(), now);
  if (result.ok && result.file.kind === "information") {
    // If it can't start now (analysis not set up, a design being analysed), the
    // Information section offers to read the brief instead.
    await enqueueBriefReading(db, found.session, found.user.id, now).catch((error) => console.error("Queueing the brief reading failed:", error));
  }
  refresh(found.company.id);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function removeFileAction(_previous: QcFormState, formData: FormData): Promise<QcFormState> {
  const found = await sessionFromForm(formData);
  const fileId = field(formData, "fileId");
  if (!found || !isUuid(fileId)) return { error: MESSAGES.notAvailable };
  const storage = getQcStorage();
  if (!storage) return { error: MESSAGES.storageNotConfigured };

  const result = await removeFile(getDatabase(), storage, found.session, fileId, new Date());
  if (!result.ok) return { error: result.error };
  refresh(found.company.id);
  return { ok: true };
}

/** An upload the browser couldn't finish: remove its record and any partial file. */
export async function cancelUploadAction(input: { sessionId: string; fileId: string }): Promise<void> {
  const found = await findSessionForUser(input?.sessionId);
  const storage = getQcStorage();
  if (!found || !storage || !isUuid(input.fileId)) return;
  await removeFile(getDatabase(), storage, found.session, input.fileId, new Date());
}

// ---------------------------------------------------------------------------
// Check Design
// ---------------------------------------------------------------------------

const briefBeingRead = async (db: ReturnType<typeof getDatabase>, sessionId: string) => {
  const run = await latestRun(db, sessionId, "information");
  return run?.status === "queued" || run?.status === "processing";
};

/** Check Design: confirms the brief's checkable requirements, marks the session Ready and checks the design. */
export async function markReadyAction(_previous: QcFormState, formData: FormData): Promise<QcFormState> {
  const found = await sessionFromForm(formData);
  if (!found) return { error: MESSAGES.notAvailable };
  const db = getDatabase();
  const [requirements, files, briefReading] = await Promise.all([
    listRequirements(db, found.session.id),
    listFiles(db, found.session.id, "ready"),
    briefBeingRead(db, found.session.id),
  ]);
  const now = new Date();
  const result = await markReady(db, found.session, requirements, files, now, { briefReading });
  if (!result.ok) return { error: result.problems.join(" ") };
  // Phase 6: analyse the content in the background (the worker picks it up).
  const queued = await enqueueRun(db, found.session, found.user.id, "content", now).catch((error) => {
    console.error("Queueing the analysis failed:", error);
    return { ok: false as const, error: MESSAGES.failed };
  });
  refresh(found.company.id);
  return { ok: true, message: queued.ok ? "Checking the design…" : "Ready to check." };
}

// ---------------------------------------------------------------------------
// Content analysis (Phase 6)
// ---------------------------------------------------------------------------

/**
 * Analyse again / try again. Kind: content (default) or information. Content
 * is only analysed against confirmed requirements — with none, QC would pass
 * content it never checked against the brief.
 */
export async function startAnalysisAction(_previous: QcFormState, formData: FormData): Promise<QcFormState> {
  const found = await sessionFromForm(formData);
  if (!found) return { error: MESSAGES.notAvailable };
  const kind: RunKind = field(formData, "kind") === "information" ? "information" : "content";
  const db = getDatabase();
  try {
    if (kind === "content" && !(await listRequirements(db, found.session.id)).some((r) => r.confirmed)) {
      return { error: READINESS_MESSAGES.requirements };
    }
    const queued = await enqueueRun(db, found.session, found.user.id, kind, new Date());
    if (!queued.ok) return { error: queued.error };
  } catch (error) {
    console.error("Queueing the analysis failed:", error);
    return { error: MESSAGES.failed };
  }
  refresh(found.company.id);
  return { ok: true };
}

export type AnalysisStatusView = {
  id: string;
  kind: RunKind;
  status: RunStatus;
  stage: string | null;
  done: number;
  total: number;
  reason: string | null;
  mock: boolean;
  /** Which provider runs it — "local" is labelled Local AI (and can be slow). */
  provider: "mock" | "google" | "local" | "gemini";
};

/** For the page's progress polling: the session's newest run of `kind`, only for its owner. */
export async function analysisStatusAction(sessionId: string, kind: RunKind = "content"): Promise<AnalysisStatusView | null> {
  const found = await findSessionForUser(sessionId);
  if (!found) return null;
  const run = await latestRun(getDatabase(), found.session.id, kind === "information" ? "information" : "content");
  if (!run) return null;
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    stage: run.stage,
    done: run.progress_done,
    total: run.progress_total,
    reason: run.failure_reason,
    mock: run.provider === "mock",
    provider: run.provider,
  };
}
