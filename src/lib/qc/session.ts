import "server-only";
import { randomUUID } from "node:crypto";
import type { Database } from "@/lib/db/database";
import {
  confirmAllRequirements,
  countFiles,
  deleteExtractedRequirementsOfFile,
  deleteFileRow,
  lockFileForRemoval,
  deleteSessionRow,
  findAnySessionId,
  findCurrentSession,
  findFile,
  insertPendingFile,
  insertSession,
  listExpiredSessions,
  type ExpiredCursor,
  listFiles,
  listStalePendingFiles,
  markFileReady,
  NO_PLATFORM,
  setSessionPlatform,
  touchSession,
  type MediaFacts,
  type QcFile,
  type QcRequirement,
  type QcSession,
} from "@/lib/db/qc-sessions";
import { contentMedia, contentTypeLabel, type ContentType } from "@/lib/qc/content-types";
import { measureMedia, MEASURED_FORMATS, type MediaInfo } from "@/lib/qc/media-info";
import { parseDimensions } from "@/lib/qc/compare";
import { BRIEF_UNCLEAR_MESSAGE, DESCRIPTIVE_REQUIREMENT_TYPES, isCheckable } from "@/lib/qc/requirements";
import {
  allowedFormats,
  checkUploadedFile,
  checkUploadRequest,
  formatForMime,
  maxBytesFor,
  maxFiles,
  QC_FILE_MESSAGES,
  SNIFF_BYTES,
  type FileKind,
} from "@/lib/qc/qc-file";
import { briefTextFileName, checkBriefText } from "@/lib/qc/brief-text";
import type { QcStorage } from "@/lib/storage/qc-storage";
import { hasActiveRun } from "@/lib/db/analysis-runs";

/** What the designer is told when a check can't be removed because its analysis is waiting or running. */
export const ANALYSIS_RUNNING_MESSAGE =
  "This check's design check or brief reading is still waiting or running. Wait until it finishes, then try again.";

/** A check can't be removed (Start over, a new check) while its analysis is waiting or running. */
export class AnalysisRunningError extends Error {
  constructor() {
    super(ANALYSIS_RUNNING_MESSAGE);
    this.name = "AnalysisRunningError";
  }
}

/**
 * Temporary QC sessions (D11) — the rules on top of lib/db/qc-sessions.ts.
 *
 * Callers must already have checked that the signed-in user may open the
 * company and owns the session (lib/qc/access.ts). Storage paths are made
 * here, from the session ID and a random file ID — never from the browser.
 */

/** An upload link that was never confirmed is cleared after this long. */
export const PENDING_UPLOAD_MINUTES = 60;

export const SESSION_MESSAGES = {
  storageDown: "Files can't be uploaded right now. Please try again in a moment.",
  notArrived: "The upload didn't finish. Please try again.",
  notAvailable: "That file isn't in this QC session any more. Reload the page.",
} as const;

// ---------------------------------------------------------------------------
// Removing sessions (Start over, expiry)
// ---------------------------------------------------------------------------

/**
 * Deletes a session's files from Storage, then the session itself (its
 * requirements and file records go with it). If Storage can't be reached
 * the session is kept, so the clean-up can be retried and no file is left
 * behind unreferenced. A session whose analysis is waiting or running is
 * kept too (for every caller: Start over, a new check, the hourly clean-up,
 * deleting a company) and removed once it has finished. Returns whether it
 * was removed (true too when it was already gone).
 *
 * All of it happens in one transaction holding a lock on the session row.
 * Queueing a run for the session needs that row too (the run refers to it),
 * so the two can't overlap: a run being queued right now is waited for and
 * then seen (the session is kept and its files are untouched); a run queued
 * from now on waits until this has finished and is then refused, because the
 * session is gone (never queued for files that were just deleted).
 *
 * The lock can never be held or waited for indefinitely (the limits are set
 * with SET LOCAL, so they end with this transaction and never carry over to
 * another request on the same pooled connection): waiting for the lock gives
 * up after LOCK_WAIT (the session is then kept, to retry later); a statement
 * stops after STATEMENT_LIMIT; and if this process stalls with the transaction
 * open, PostgreSQL ends it after IDLE_LIMIT. Storage calls stop after 20 s
 * each (storage-api.ts). Any error rolls everything back; nothing in the
 * database changes until the session row is deleted, the last step.
 */
export async function removeSessionCompletely(
  db: Database,
  storage: QcStorage | null,
  sessionId: string
): Promise<boolean> {
  try {
    return await db.transaction((tx) => removeLockedSession(tx, storage, sessionId));
  } catch (error) {
    // Another removal of the same session (e.g. the hourly clean-up) held the lock too long: kept for now.
    if (isLockTimeout(error)) return false;
    throw error;
  }
}

/** Waiting for the session's lock (another removal is deleting its files). */
const LOCK_WAIT = "10s";
/** Any one statement inside the removal. */
const STATEMENT_LIMIT = "30s";
/** The transaction left open with nothing happening (longer than two 20 s Storage calls). */
const IDLE_LIMIT = "2min";

/** PostgreSQL's lock_not_available (lock_timeout reached). */
const isLockTimeout = (error: unknown) => (error as { code?: unknown } | null)?.code === "55P03";

async function removeLockedSession(tx: Database, storage: QcStorage | null, sessionId: string): Promise<boolean> {
  await tx.query(`set local lock_timeout = '${LOCK_WAIT}'`);
  await tx.query(`set local statement_timeout = '${STATEMENT_LIMIT}'`);
  await tx.query(`set local idle_in_transaction_session_timeout = '${IDLE_LIMIT}'`);
  const [locked] = await tx.query("select id from qc_sessions where id = $1 for update", [sessionId]);
  if (!locked) return true;
  if (await hasActiveRun(tx, sessionId)) return false;
  const hasFiles = (await listFiles(tx, sessionId, "any")).length > 0;
  if (storage) {
    try {
      // The whole folder, so files whose upload never finished go too.
      const names = await storage.list(sessionId);
      await storage.remove(names.map((name) => `${sessionId}/${name}`));
    } catch (error) {
      console.error(`Could not delete QC session files from Storage (${sessionId}); will retry:`, error);
      return false;
    }
  } else if (hasFiles) {
    console.error(`QC session ${sessionId} has files but Storage isn't configured; kept for a later clean-up.`);
    return false;
  }
  // Still refuses a session with a waiting or running run (it can't have one here, under the lock).
  return deleteSessionRow(tx, sessionId);
}

/** How many expired sessions one clean-up batch handles at most. */
export const CLEANUP_BATCH_SIZE = 50;

/** Deletes expired sessions (all companies, all designers), oldest first, one batch. Returns how many were removed. */
export async function purgeExpiredSessions(
  db: Database,
  storage: QcStorage | null,
  now: Date
): Promise<number> {
  return (await purgeExpiredBatch(db, storage, now, null)).removed;
}

export type CleanupBatch = {
  removed: number;
  /** Tried but kept: their files couldn't be deleted yet (removeSessionCompletely). */
  kept: number;
  /** Where the next batch continues; null = start again from the oldest. */
  next: ExpiredCursor | null;
};

/**
 * One clean-up batch for the worker's hourly sweep: up to CLEANUP_BATCH_SIZE expired sessions after
 * `after`, each removed files first (removeSessionCompletely — a session whose files can't be deleted is
 * kept). The next batch continues after the last one tried, so sessions that keep failing can't block
 * newer ones; after the last batch it starts again from the oldest, so kept sessions are retried.
 */
export async function purgeExpiredBatch(
  db: Database,
  storage: QcStorage | null,
  now: Date,
  after: ExpiredCursor | null
): Promise<CleanupBatch> {
  const expired = await listExpiredSessions(db, now, CLEANUP_BATCH_SIZE, after);
  let removed = 0;
  for (const { id } of expired) {
    if (await removeSessionCompletely(db, storage, id)) removed++;
  }
  const last = expired.at(-1);
  const full = expired.length === CLEANUP_BATCH_SIZE;
  return { removed, kept: expired.length - removed, next: full && last ? { expiresAt: last.expires_at, id: last.id } : null };
}

/**
 * The designer's current session for the company: resumed if it is still
 * running, otherwise a new one (an expired one is cleared first).
 */
export async function startSession(
  db: Database,
  storage: QcStorage | null,
  input: { companyId: string; userId: string; contentType: ContentType },
  now: Date
): Promise<QcSession> {
  const current = await findCurrentSession(db, input.companyId, input.userId, now);
  if (current) return current;

  const stale = await findAnySessionId(db, input.companyId, input.userId);
  // An expired check whose analysis is still waiting or running is kept until it finishes: removing it
  // would stop it counting towards the user's analyses running at once while the worker still runs it.
  if (stale && (await hasActiveRun(db, stale))) throw new AnalysisRunningError();
  if (stale && !(await removeSessionCompletely(db, storage, stale))) {
    if (await hasActiveRun(db, stale)) throw new AnalysisRunningError(); // queued at the same moment
    throw new Error("An expired QC session couldn't be cleared yet.");
  }
  const created = await insertSession(db, input, now);
  if (created) return created;
  // Started at the same moment in another tab — use that one.
  const raced = await findCurrentSession(db, input.companyId, input.userId, now);
  if (!raced) throw new Error("QC session could not be started.");
  return raced;
}

// ---------------------------------------------------------------------------
// Content type
// ---------------------------------------------------------------------------

/**
 * Changes what's being checked. Refused while uploaded content doesn't fit
 * the new type (e.g. images uploaded, switching to Reel) — the designer
 * removes that content first.
 */
export async function changeContentType(
  db: Database,
  session: QcSession,
  contentType: ContentType,
  now: Date
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (contentType === session.content_type) return { ok: true };
  const allowed = allowedFormats("content", contentType);
  const content = (await listFiles(db, session.id, "any")).filter((f) => f.kind === "content");
  const misfit = content.find((file) => {
    const format = formatForMime(file.mime_type);
    return !format || !allowed.includes(format);
  });
  if (misfit || content.length > maxFiles("content", contentType)) {
    return {
      ok: false,
      error: `Remove the uploaded content first — ${contentTypeLabel(contentType)} needs different files.`,
    };
  }
  await touchSession(db, session.id, now, { contentType });
  // Images and videos have different platforms / placements: choose again.
  if (contentMedia(contentType) !== contentMedia(session.content_type) && session.platform) {
    await setSessionPlatform(db, session.id, NO_PLATFORM, now);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Uploads: 1) hand out a one-time upload link, 2) check what arrived
// ---------------------------------------------------------------------------

export type PrepareResult =
  | { ok: true; fileId: string; uploadUrl: string; contentType: string }
  | { ok: false; error: string };

async function clearStalePending(db: Database, storage: QcStorage, sessionId: string, now: Date) {
  const before = new Date(now.getTime() - PENDING_UPLOAD_MINUTES * 60_000);
  for (const file of await listStalePendingFiles(db, sessionId, before)) {
    try {
      await storage.remove([file.storage_path]);
      await deleteFileRow(db, sessionId, file.id);
    } catch (error) {
      console.error("Clearing an unfinished upload failed:", error);
    }
  }
}

export async function prepareUpload(
  db: Database,
  storage: QcStorage,
  session: QcSession,
  /** `replacing`: the id of a file of the same kind this upload will replace (removed only once the new one is confirmed). */
  request: { kind: FileKind; name: string; size: number; type: string; replacing?: string },
  generalLimitBytes: number,
  now: Date
): Promise<PrepareResult> {
  await clearStalePending(db, storage, session.id, now);

  const plan = checkUploadRequest(request, request.kind, session.content_type, generalLimitBytes);
  if (!plan.ok) return plan;

  // A replacement takes the old file's place, so a full area still has room for it.
  let replacingOne = false;
  if (request.replacing) {
    const old = (await listFiles(db, session.id)).find((f) => f.id === request.replacing && f.kind === request.kind);
    if (!old) return { ok: false, error: QC_FILE_MESSAGES.replaceGone };
    replacingOne = true;
  }
  const limit = maxFiles(request.kind, session.content_type);
  if ((await countFiles(db, session.id, request.kind)) - (replacingOne ? 1 : 0) >= limit) {
    return { ok: false, error: QC_FILE_MESSAGES.tooMany(limit) };
  }

  const fileId = randomUUID();
  const storagePath = `${session.id}/${fileId}.${plan.value.ext}`;
  await insertPendingFile(
    db,
    session.id,
    {
      id: fileId,
      kind: request.kind,
      fileName: plan.value.fileName,
      storagePath,
      mimeType: plan.value.mime,
      fileSize: request.size,
    },
    now
  );

  try {
    const uploadUrl = await storage.signedUploadUrl(storagePath);
    return { ok: true, fileId, uploadUrl, contentType: plan.value.mime };
  } catch (error) {
    console.error("Making an upload link failed:", error);
    await deleteFileRow(db, session.id, fileId);
    return { ok: false, error: SESSION_MESSAGES.storageDown };
  }
}

/**
 * Checks the file that actually arrived in Storage: its first bytes must be
 * the expected format and its real size within the limit. A file that fails
 * is deleted from Storage and from the session.
 */
export async function confirmUpload(
  db: Database,
  storage: QcStorage,
  session: QcSession,
  fileId: string,
  generalLimitBytes: number,
  now: Date
): Promise<{ ok: true; file: QcFile } | { ok: false; error: string }> {
  const file = await findFile(db, session.id, fileId);
  if (!file) return { ok: false, error: SESSION_MESSAGES.notAvailable };
  if (file.status === "ready") return { ok: true, file };

  const reject = async (error: string) => {
    await storage.remove([file.storage_path]).catch((e) => console.error("Removing a rejected upload failed:", e));
    await deleteFileRow(db, session.id, file.id);
    return { ok: false as const, error };
  };

  const format = formatForMime(file.mime_type);
  if (!format || !allowedFormats(file.kind, session.content_type).includes(format)) {
    return reject(QC_FILE_MESSAGES.wrongType(file.kind, session.content_type));
  }

  let stored;
  try {
    stored = await storage.readStart(file.storage_path, SNIFF_BYTES);
  } catch (error) {
    console.error("Reading back an upload failed:", error);
    return { ok: false, error: SESSION_MESSAGES.storageDown };
  }
  if (!stored) return reject(SESSION_MESSAGES.notArrived);

  const problem = checkUploadedFile({ format, maxBytes: maxBytesFor(format, generalLimitBytes) }, stored);
  if (problem) return reject(problem);

  const media = file.kind === "content" ? await measureContent(storage, file.storage_path, format, stored) : {};
  await markFileReady(db, session.id, file.id, stored.totalSize, now, media);
  await touchSession(db, session.id, now);
  return { ok: true, file: { ...file, ...mediaColumns(media), status: "ready", file_size: stored.totalSize } };
}

/**
 * A brief typed or pasted into step 1: saved as a plain-text information file in the session's own
 * folder (`{sessionId}/{fileId}.txt`, a server-made path), then confirmed by confirmUpload — the same
 * format and size checks as an uploaded .txt brief. From there it is the same as any uploaded brief:
 * read by the brief reading, its requirements confirmed by Check Design, removed with its session.
 * The text is never logged.
 */
export async function saveBriefText(
  db: Database,
  storage: QcStorage,
  session: QcSession,
  rawText: unknown,
  generalLimitBytes: number,
  now: Date,
  /** briefTextLimit for the configured AI: never more than it reads of a brief, so nothing is cut short. */
  maxChars?: number
): Promise<{ ok: true; file: QcFile } | { ok: false; error: string }> {
  const checked = checkBriefText(rawText, maxChars);
  if (!checked.ok) return checked;
  await clearStalePending(db, storage, session.id, now);

  const information = (await listFiles(db, session.id, "any")).filter((f) => f.kind === "information");
  const bytes = new TextEncoder().encode(`${checked.value}\n`);
  const plan = checkUploadRequest(
    { name: briefTextFileName(information.map((f) => f.file_name)), size: bytes.length, type: "text/plain" },
    "information",
    session.content_type,
    generalLimitBytes
  );
  if (!plan.ok) return plan;
  const limit = maxFiles("information", session.content_type);
  if (information.length >= limit) return { ok: false, error: QC_FILE_MESSAGES.tooMany(limit) };

  const fileId = randomUUID();
  const storagePath = `${session.id}/${fileId}.${plan.value.ext}`;
  await insertPendingFile(
    db,
    session.id,
    { id: fileId, kind: "information", fileName: plan.value.fileName, storagePath, mimeType: plan.value.mime, fileSize: bytes.length },
    now
  );
  try {
    await storage.upload(storagePath, bytes, plan.value.mime);
  } catch (error) {
    console.error("Saving a typed brief to Storage failed:", error instanceof Error ? error.message : "unknown error");
    await storage.remove([storagePath]).catch(() => {});
    await deleteFileRow(db, session.id, fileId);
    return { ok: false, error: SESSION_MESSAGES.storageDown };
  }
  return confirmUpload(db, storage, session, fileId, generalLimitBytes, now);
}

/**
 * Measures uploaded content for the platform / size checks (5.11): from the
 * bytes already read when that's enough, otherwise from the whole file (a
 * video's details can sit at its end). Never throws — a failure is recorded
 * as a note, and the checks report it as not verified.
 */
async function measureContent(
  storage: QcStorage,
  path: string,
  format: NonNullable<ReturnType<typeof formatForMime>>,
  start: { bytes: Uint8Array; totalSize: number }
): Promise<MediaFacts> {
  if (!MEASURED_FORMATS.includes(format)) return {};
  const complete = (m: MediaInfo) =>
    m.width !== undefined && m.height !== undefined && (contentMediaOf(format) !== "video" || m.durationMs !== undefined);
  let info = measureMedia(format, start.bytes);
  if (!complete(info) && start.totalSize > start.bytes.length) {
    try {
      const whole = await storage.readStart(path, start.totalSize);
      if (whole) info = measureMedia(format, whole.bytes);
    } catch (error) {
      console.error("Reading a QC file to measure it failed:", error);
      return { note: "The file couldn't be read to measure it." };
    }
  }
  const facts: MediaFacts = {
    width: info.width,
    height: info.height,
    durationMs: info.durationMs,
    dpi: info.dpi,
    pages: info.pages,
    note: info.note,
  };
  if (!complete(info) && !facts.note) facts.note = "The file's size details couldn't be found.";
  return facts;
}

const contentMediaOf = (format: string) => (["mp4", "mov", "webm"].includes(format) ? "video" : "visual");

function mediaColumns(media: MediaFacts): Pick<
  QcFile,
  "media_width" | "media_height" | "media_duration_ms" | "media_dpi" | "media_pages" | "media_note"
> {
  return {
    media_width: media.width ?? null,
    media_height: media.height ?? null,
    media_duration_ms: media.durationMs === undefined ? null : Math.round(media.durationMs),
    media_dpi: media.dpi === undefined ? null : Math.round(media.dpi),
    media_pages: media.pages ?? null,
    media_note: media.note ?? null,
  };
}

/**
 * Removes one file (or an unfinished upload) from the session and from Storage. A brief file takes the
 * requirements read from it with it (in the same transaction); manually entered requirements stay.
 */
export async function removeFile(
  db: Database,
  storage: QcStorage,
  session: QcSession,
  fileId: string,
  now: Date
): Promise<{ ok: true } | { ok: false; error: string }> {
  const path = await db.transaction(async (tx) => {
    // Locked first: a brief reading saving requirements for this file finishes before they're removed.
    if (!(await lockFileForRemoval(tx, session.id, fileId))) return null;
    await deleteExtractedRequirementsOfFile(tx, session.id, fileId);
    return deleteFileRow(tx, session.id, fileId);
  });
  if (!path) return { ok: false, error: SESSION_MESSAGES.notAvailable };
  try {
    await storage.remove([path]);
  } catch (error) {
    // The record is gone; the session's folder is cleared again when it ends.
    console.error("Removing a QC file from Storage failed; it goes with the session:", error);
  }
  await touchSession(db, session.id, now);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

export const READINESS_MESSAGES = {
  /** No checkable requirement to compare the design with (never a PASS without one). */
  requirements: "Add or confirm the client's requirements before running QC.",
  brief: "Upload or type the client brief.",
  briefReading: "The brief is still being read — this takes a few seconds.",
  /** The brief files have changed since their last successful reading, or that reading failed. */
  briefNotRead: "The current brief hasn't been read successfully yet — read it again in step 1 before checking the design.",
  briefUnclear: BRIEF_UNCLEAR_MESSAGE,
  content: "Upload the design.",
} as const;

/** A requirement giving an exact pixel size — enough to check the size without a platform. */
export const hasExactSize = (requirements: Pick<QcRequirement, "type" | "expected_value">[]) =>
  requirements.some((r) => r.type === "dimensions" && parseDimensions(r.expected_value) !== null);

/**
 * What still stops Check Design (empty when it can run). Check Design confirms
 * every checkable requirement, so at least one must be there — QC with none
 * would pass a design it never checked against the brief. Descriptive items
 * (campaign, instructions…) don't count: they are never checked.
 *
 * The platform is OPTIONAL: without one, the general checks run and the
 * platform-specific ones are shown as not checked (lib/qc/rules/platform-size.ts).
 * `session` is kept for callers; it no longer stops Check Design.
 */
export function readinessProblems(
  requirements: QcRequirement[],
  files: QcFile[],
  _session?: Pick<QcSession, "platform">,
  /**
   * briefTooLong: the brief reading's message when Local AI couldn't read a brief file in full (brief-length.ts).
   * briefNotRead: the current brief files haven't been read successfully (briefReadiness in enqueue.ts).
   */
  options: BriefReadiness = {}
): string[] {
  const problems: string[] = [];
  const checkable = requirements.filter(isCheckable);
  const hasBrief = files.some((file) => file.kind === "information" && file.status === "ready");
  const brief = briefProblem(options);
  if (brief) problems.push(brief);
  else if (checkable.length === 0) problems.push(hasBrief ? READINESS_MESSAGES.briefUnclear : READINESS_MESSAGES.brief);
  if (!files.some((file) => file.kind === "content" && file.status === "ready")) {
    problems.push(READINESS_MESSAGES.content);
  }
  return problems;
}

export type BriefReadiness = { briefReading?: boolean; briefTooLong?: string | null; briefNotRead?: boolean };

/**
 * Why the design can't be checked yet because of the brief, or null. Used by Check Design and by the
 * design check's Try again alike: never checked against a brief still being read, too long for Local AI
 * (never part of a brief), or not read successfully since it last changed (never outdated requirements).
 */
export function briefProblem(options: BriefReadiness): string | null {
  if (options.briefReading) return READINESS_MESSAGES.briefReading;
  if (options.briefTooLong) return options.briefTooLong;
  if (options.briefNotRead) return READINESS_MESSAGES.briefNotRead;
  return null;
}

/** Check Design: confirms the checkable requirements and marks the session Ready. */
export async function markReady(
  db: Database,
  session: QcSession,
  requirements: QcRequirement[],
  files: QcFile[],
  now: Date,
  options: BriefReadiness = {}
): Promise<{ ok: true } | { ok: false; problems: string[] }> {
  const problems = readinessProblems(requirements, files, session, options);
  if (problems.length > 0) return { ok: false, problems };
  await confirmAllRequirements(db, session.id, now, DESCRIPTIVE_REQUIREMENT_TYPES);
  await touchSession(db, session.id, now, { status: "ready" });
  return { ok: true };
}
