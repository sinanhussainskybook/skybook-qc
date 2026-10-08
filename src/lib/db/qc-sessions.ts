import type { Database } from "@/lib/db/database";
import type { ContentType } from "@/lib/qc/content-types";
import type { FileKind } from "@/lib/qc/qc-file";
import type { RequirementInput, RequirementSource } from "@/lib/qc/requirements";

/**
 * Temporary QC sessions (D11): tables qc_sessions, qc_requirements, qc_files.
 *
 * A session belongs to one designer and one company. Reads take the
 * designer's user ID, so another designer's session is simply "not found".
 * Requirement and file changes always include `session_id = …`, so an item
 * can only be changed through its own session.
 */

/** A session lasts this long after its last change (D11). */
export const SESSION_LIFETIME_HOURS = 24;

const EXPIRES = (param: string) => `(${param}::timestamptz + interval '${SESSION_LIFETIME_HOURS} hours')`;

export type QcSessionStatus = "draft" | "ready";

export type QcSession = {
  id: string;
  company_id: string;
  user_id: string;
  content_type: ContentType;
  status: QcSessionStatus;
  /** Platform / placement (Phase 5, D4) — keys from lib/qc/platforms.ts. */
  platform: string | null;
  placement: string | null;
  /** The size the designer typed, for platforms with no official spec. */
  custom_label: string | null;
  custom_width: number | null;
  custom_height: number | null;
  custom_unit: "px" | "mm" | null;
  custom_min_dpi: number | null;
  custom_max_bytes: number | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
};

export type QcRequirement = {
  id: string;
  type: string;
  label: string | null;
  expected_value: string;
  notes: string | null;
  mandatory: boolean;
  confirmed: boolean;
  source: RequirementSource;
  source_file_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type QcFile = {
  id: string;
  kind: FileKind;
  file_name: string;
  storage_path: string;
  mime_type: string;
  file_size: number;
  status: "pending" | "ready";
  /** Measured from the content itself when it was confirmed (Phase 5). */
  media_width: number | null;
  media_height: number | null;
  media_duration_ms: number | null;
  media_dpi: number | null;
  media_pages: number | null;
  media_note: string | null;
  created_at: Date;
  updated_at: Date;
};

const SESSION_COLUMNS =
  "id, company_id, user_id, content_type, status, platform, placement, custom_label, custom_width, custom_height, " +
  "custom_unit, custom_min_dpi, custom_max_bytes::int as custom_max_bytes, expires_at, created_at, updated_at";
const FILE_COLUMNS =
  "id, kind, file_name, storage_path, mime_type, file_size::int as file_size, status, media_width, media_height, " +
  "media_duration_ms::int as media_duration_ms, media_dpi, media_pages, media_note, created_at, updated_at";

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** The designer's current (not expired) session for this company, or null. */
export async function findCurrentSession(
  db: Database,
  companyId: string,
  userId: string,
  now: Date
): Promise<QcSession | null> {
  const [row] = await db.query<QcSession>(
    `select ${SESSION_COLUMNS} from qc_sessions
      where company_id = $1 and user_id = $2 and expires_at > $3`,
    [companyId, userId, now]
  );
  return row ?? null;
}

/** A session by ID — only the designer who owns it, and only while it hasn't expired. */
export async function findOwnedSession(
  db: Database,
  sessionId: string,
  userId: string,
  now: Date
): Promise<QcSession | null> {
  const [row] = await db.query<QcSession>(
    `select ${SESSION_COLUMNS} from qc_sessions
      where id = $1 and user_id = $2 and expires_at > $3`,
    [sessionId, userId, now]
  );
  return row ?? null;
}

/**
 * Creates the designer's session for the company. Returns null if one
 * already exists (the caller clears an expired one first).
 */
export async function insertSession(
  db: Database,
  input: { companyId: string; userId: string; contentType: ContentType },
  now: Date
): Promise<QcSession | null> {
  const [row] = await db.query<QcSession>(
    `insert into qc_sessions (company_id, user_id, content_type, expires_at, created_at, updated_at)
     values ($1, $2, $3, ${EXPIRES("$4")}, $4, $4)
     on conflict (company_id, user_id) do nothing
     returning ${SESSION_COLUMNS}`,
    [input.companyId, input.userId, input.contentType, now]
  );
  return row ?? null;
}

/**
 * Records a change: the 24-hour clock restarts, and the session goes back
 * to draft unless the change is "mark ready".
 */
export async function touchSession(
  db: Database,
  sessionId: string,
  now: Date,
  changes: { status?: QcSessionStatus; contentType?: ContentType } = {}
): Promise<void> {
  await db.query(
    `update qc_sessions set
       status = $3,
       content_type = coalesce($4, content_type),
       updated_at = $2,
       expires_at = ${EXPIRES("$2")}
     where id = $1`,
    [sessionId, now, changes.status ?? "draft", changes.contentType ?? null]
  );
}

export type PlatformChoice = {
  platform: string | null;
  placement: string | null;
  customLabel: string | null;
  customWidth: number | null;
  customHeight: number | null;
  customUnit: "px" | "mm" | null;
  customMinDpi: number | null;
  customMaxBytes: number | null;
};

export const NO_PLATFORM: PlatformChoice = {
  platform: null,
  placement: null,
  customLabel: null,
  customWidth: null,
  customHeight: null,
  customUnit: null,
  customMinDpi: null,
  customMaxBytes: null,
};

/** Sets (or, with NO_PLATFORM, clears) the platform choice. Counts as a change. */
export async function setSessionPlatform(db: Database, sessionId: string, choice: PlatformChoice, now: Date): Promise<void> {
  await db.query(
    `update qc_sessions set
       platform = $3, placement = $4, custom_label = $5, custom_width = $6, custom_height = $7,
       custom_unit = $8, custom_min_dpi = $9, custom_max_bytes = $10,
       status = 'draft', updated_at = $2, expires_at = ${EXPIRES("$2")}
     where id = $1`,
    [
      sessionId,
      now,
      choice.platform,
      choice.placement,
      choice.customLabel,
      choice.customWidth,
      choice.customHeight,
      choice.customUnit,
      choice.customMinDpi,
      choice.customMaxBytes,
    ]
  );
}

export async function deleteSessionRow(db: Database, sessionId: string): Promise<void> {
  await db.query("delete from qc_sessions where id = $1", [sessionId]);
}

/** IDs of sessions past their expiry (any company, any designer) — for clean-up. */
export async function listExpiredSessionIds(db: Database, now: Date, limit = 50): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    "select id from qc_sessions where expires_at <= $1 order by expires_at limit $2",
    [now, limit]
  );
  return rows.map((row) => row.id);
}

/** The designer's session for the company whatever its expiry — for Start over / clean-up. */
export async function findAnySessionId(db: Database, companyId: string, userId: string): Promise<string | null> {
  const [row] = await db.query<{ id: string }>(
    "select id from qc_sessions where company_id = $1 and user_id = $2",
    [companyId, userId]
  );
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

const REQUIREMENT_COLUMNS =
  "id, type, label, expected_value, notes, mandatory, confirmed, source, source_file_id, created_at, updated_at";

export async function listRequirements(db: Database, sessionId: string): Promise<QcRequirement[]> {
  return db.query<QcRequirement>(
    `select ${REQUIREMENT_COLUMNS} from qc_requirements where session_id = $1 order by created_at, id`,
    [sessionId]
  );
}

export async function insertRequirement(
  db: Database,
  sessionId: string,
  input: RequirementInput,
  now: Date
): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `insert into qc_requirements
       (session_id, type, label, expected_value, notes, mandatory, confirmed, source, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'manual', $8, $8)
     returning id`,
    [sessionId, input.type, input.label, input.expected_value, input.notes, input.mandatory, input.confirmed, now]
  );
  return row.id;
}

/**
 * A requirement found in an uploaded information file (6.7). Always
 * UNCONFIRMED and optional: unconfirmed requirements are never used by the QC
 * engine until the designer reviews and confirms them.
 */
export async function insertExtractedRequirement(
  db: Database,
  sessionId: string,
  input: { type: string; label: string | null; expectedValue: string; notes: string | null; sourceFileId: string; mandatory?: boolean },
  now: Date
): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `insert into qc_requirements
       (session_id, type, label, expected_value, notes, mandatory, confirmed, source, source_file_id, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $8, false, 'extracted', $6, $7, $7)
     returning id`,
    [sessionId, input.type, input.label, input.expectedValue, input.notes, input.sourceFileId, now, input.mandatory ?? false]
  );
  return row.id;
}

/** Confirm & Run QC: every requirement in the session is confirmed at once. */
export async function confirmAllRequirements(db: Database, sessionId: string, now: Date): Promise<number> {
  const rows = await db.query(
    "update qc_requirements set confirmed = true, updated_at = $2 where session_id = $1 and confirmed = false returning id",
    [sessionId, now]
  );
  return rows.length;
}

/** Returns false if the requirement isn't in this session. */
export async function updateRequirement(
  db: Database,
  sessionId: string,
  requirementId: string,
  input: RequirementInput,
  now: Date
): Promise<boolean> {
  const rows = await db.query(
    `update qc_requirements set
       type = $3, label = $4, expected_value = $5, notes = $6, mandatory = $7, confirmed = $8, updated_at = $9
     where id = $1 and session_id = $2
     returning id`,
    [requirementId, sessionId, input.type, input.label, input.expected_value, input.notes, input.mandatory, input.confirmed, now]
  );
  return rows.length > 0;
}

export async function setRequirementConfirmed(
  db: Database,
  sessionId: string,
  requirementId: string,
  confirmed: boolean,
  now: Date
): Promise<boolean> {
  const rows = await db.query(
    `update qc_requirements set confirmed = $3, updated_at = $4
     where id = $1 and session_id = $2 returning id`,
    [requirementId, sessionId, confirmed, now]
  );
  return rows.length > 0;
}

export async function deleteRequirement(db: Database, sessionId: string, requirementId: string): Promise<boolean> {
  const rows = await db.query(
    "delete from qc_requirements where id = $1 and session_id = $2 returning id",
    [requirementId, sessionId]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Files (metadata only — the files are in Storage)
// ---------------------------------------------------------------------------

export async function listFiles(db: Database, sessionId: string, status: "ready" | "any" = "ready"): Promise<QcFile[]> {
  return db.query<QcFile>(
    `select ${FILE_COLUMNS} from qc_files
      where session_id = $1 and ($2 = 'any' or status = 'ready')
      order by created_at, id`,
    [sessionId, status]
  );
}

/** Files in one upload area, including uploads still in progress. */
export async function countFiles(db: Database, sessionId: string, kind: FileKind): Promise<number> {
  const [row] = await db.query<{ count: number }>(
    "select count(*)::int as count from qc_files where session_id = $1 and kind = $2",
    [sessionId, kind]
  );
  return Number(row.count);
}

export async function insertPendingFile(
  db: Database,
  sessionId: string,
  file: { id: string; kind: FileKind; fileName: string; storagePath: string; mimeType: string; fileSize: number },
  now: Date
): Promise<void> {
  await db.query(
    `insert into qc_files (id, session_id, kind, file_name, storage_path, mime_type, file_size, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $8)`,
    [file.id, sessionId, file.kind, file.fileName, file.storagePath, file.mimeType, file.fileSize, now]
  );
}

export async function findFile(db: Database, sessionId: string, fileId: string): Promise<QcFile | null> {
  const [row] = await db.query<QcFile>(
    `select ${FILE_COLUMNS} from qc_files where id = $1 and session_id = $2`,
    [fileId, sessionId]
  );
  return row ?? null;
}

/** What was measured from a file's content (Phase 5). Absent values stay null. */
export type MediaFacts = {
  width?: number;
  height?: number;
  durationMs?: number;
  dpi?: number;
  pages?: number;
  note?: string;
};

export async function markFileReady(
  db: Database,
  sessionId: string,
  fileId: string,
  realSize: number,
  now: Date,
  media: MediaFacts = {}
): Promise<boolean> {
  const rows = await db.query(
    `update qc_files set status = 'ready', file_size = $3, updated_at = $4,
       media_width = $5, media_height = $6, media_duration_ms = $7, media_dpi = $8, media_pages = $9, media_note = $10
     where id = $1 and session_id = $2 returning id`,
    [
      fileId,
      sessionId,
      realSize,
      now,
      media.width ?? null,
      media.height ?? null,
      media.durationMs === undefined ? null : Math.round(media.durationMs),
      media.dpi === undefined ? null : Math.round(media.dpi),
      media.pages ?? null,
      media.note ? media.note.slice(0, 300) : null,
    ]
  );
  return rows.length > 0;
}

/** Uploads that were started but never confirmed before `before` (e.g. the tab was closed). */
export async function listStalePendingFiles(
  db: Database,
  sessionId: string,
  before: Date
): Promise<{ id: string; storage_path: string }[]> {
  return db.query<{ id: string; storage_path: string }>(
    "select id, storage_path from qc_files where session_id = $1 and status = 'pending' and created_at < $2",
    [sessionId, before]
  );
}

/** Removes a file record. Returns its storage path (to delete the file), or null. */
export async function deleteFileRow(db: Database, sessionId: string, fileId: string): Promise<string | null> {
  const [row] = await db.query<{ storage_path: string }>(
    "delete from qc_files where id = $1 and session_id = $2 returning storage_path",
    [fileId, sessionId]
  );
  return row?.storage_path ?? null;
}
