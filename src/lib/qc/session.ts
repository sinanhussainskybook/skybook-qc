import "server-only";
import { randomUUID } from "node:crypto";
import type { Database } from "@/lib/db/database";
import {
  countFiles,
  deleteFileRow,
  deleteSessionRow,
  findAnySessionId,
  findCurrentSession,
  findFile,
  insertPendingFile,
  insertSession,
  listExpiredSessionIds,
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
import type { QcStorage } from "@/lib/storage/qc-storage";

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
 * behind unreferenced. Returns whether it was removed.
 */
export async function removeSessionCompletely(
  db: Database,
  storage: QcStorage | null,
  sessionId: string
): Promise<boolean> {
  const hasFiles = (await listFiles(db, sessionId, "any")).length > 0;
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
  await deleteSessionRow(db, sessionId);
  return true;
}

/** Deletes every expired session (all companies, all designers). Returns how many were removed. */
export async function purgeExpiredSessions(
  db: Database,
  storage: QcStorage | null,
  now: Date
): Promise<number> {
  let removed = 0;
  for (const id of await listExpiredSessionIds(db, now)) {
    if (await removeSessionCompletely(db, storage, id)) removed++;
  }
  return removed;
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
  if (stale && !(await removeSessionCompletely(db, storage, stale))) {
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
  request: { kind: FileKind; name: string; size: number; type: string },
  generalLimitBytes: number,
  now: Date
): Promise<PrepareResult> {
  await clearStalePending(db, storage, session.id, now);

  const plan = checkUploadRequest(request, request.kind, session.content_type, generalLimitBytes);
  if (!plan.ok) return plan;

  const limit = maxFiles(request.kind, session.content_type);
  if ((await countFiles(db, session.id, request.kind)) >= limit) {
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

/** Removes one file (or an unfinished upload) from the session and from Storage. */
export async function removeFile(
  db: Database,
  storage: QcStorage,
  session: QcSession,
  fileId: string,
  now: Date
): Promise<{ ok: true } | { ok: false; error: string }> {
  const path = await deleteFileRow(db, session.id, fileId);
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

/** What still stops the session being Ready (empty when it can be marked Ready). */
export function readinessProblems(
  requirements: QcRequirement[],
  files: QcFile[],
  session?: Pick<QcSession, "platform">
): string[] {
  const problems: string[] = [];
  if (session && !session.platform) {
    problems.push("Choose the platform the content is for.");
  }
  if (!files.some((file) => file.kind === "content" && file.status === "ready")) {
    problems.push("Upload the content you want checked.");
  }
  const unconfirmed = requirements.filter((r) => !r.confirmed).length;
  if (unconfirmed > 0) {
    problems.push(
      `Confirm or delete ${unconfirmed} requirement${unconfirmed === 1 ? "" : "s"} — unconfirmed requirements are never used.`
    );
  }
  return problems;
}

export async function markReady(
  db: Database,
  session: QcSession,
  requirements: QcRequirement[],
  files: QcFile[],
  now: Date
): Promise<{ ok: true } | { ok: false; problems: string[] }> {
  const problems = readinessProblems(requirements, files, session);
  if (problems.length > 0) return { ok: false, problems };
  await touchSession(db, session.id, now, { status: "ready" });
  return { ok: true };
}
