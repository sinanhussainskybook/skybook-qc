import { cleanFileName, formatBytes } from "@/lib/company/logo-file";
import { contentMedia, type ContentType } from "@/lib/qc/content-types";

/**
 * Checks for files uploaded into a QC session (D11). Every upload is
 * untrusted. It is checked twice on the server:
 *
 *   1. before upload — name, extension, declared type and size must be
 *      allowed for that upload area and content type (checkUploadRequest);
 *   2. after upload  — the first bytes of what actually arrived in Storage
 *      must be that format, and its real size within the limit
 *      (checkUploadedFile). A file that fails is deleted.
 *
 * The app never opens, runs or displays these files as web pages.
 */

export const FILE_FORMATS = {
  pdf: { mime: "application/pdf", extensions: ["pdf"], label: "PDF" },
  doc: { mime: "application/msword", extensions: ["doc"], label: "DOC" },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: ["docx"],
    label: "DOCX",
  },
  xls: { mime: "application/vnd.ms-excel", extensions: ["xls"], label: "XLS" },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: ["xlsx"],
    label: "XLSX",
  },
  txt: { mime: "text/plain", extensions: ["txt"], label: "TXT" },
  jpeg: { mime: "image/jpeg", extensions: ["jpg", "jpeg"], label: "JPG" },
  png: { mime: "image/png", extensions: ["png"], label: "PNG" },
  webp: { mime: "image/webp", extensions: ["webp"], label: "WEBP" },
  mp4: { mime: "video/mp4", extensions: ["mp4"], label: "MP4" },
  mov: { mime: "video/quicktime", extensions: ["mov"], label: "MOV" },
  webm: { mime: "video/webm", extensions: ["webm"], label: "WEBM" },
} as const;

export type FileFormat = keyof typeof FILE_FORMATS;

/** The two upload areas on the page. */
export type FileKind = "information" | "content";

export const INFORMATION_FORMATS: readonly FileFormat[] = [
  "pdf", "doc", "docx", "xls", "xlsx", "txt", "jpeg", "png", "webp",
];
const VISUAL_CONTENT_FORMATS: readonly FileFormat[] = ["jpeg", "png", "webp", "pdf"];
const VIDEO_CONTENT_FORMATS: readonly FileFormat[] = ["mp4", "mov", "webm"];

export function allowedFormats(kind: FileKind, contentType: ContentType): readonly FileFormat[] {
  if (kind === "information") return INFORMATION_FORMATS;
  return contentMedia(contentType) === "video" ? VIDEO_CONTENT_FORMATS : VISUAL_CONTENT_FORMATS;
}

/** How many files each area may hold at once. */
export function maxFiles(kind: FileKind, contentType: ContentType): number {
  if (kind === "information") return 10;
  return contentMedia(contentType) === "video" ? 1 : 10;
}

/** Video: 50 MB — the Supabase Free plan's per-file maximum (D11). */
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

export function maxBytesFor(format: FileFormat, generalLimitBytes: number): number {
  return VIDEO_CONTENT_FORMATS.includes(format) ? VIDEO_MAX_BYTES : generalLimitBytes;
}

/** Bytes read back from Storage to confirm a file's format. */
export const SNIFF_BYTES = 64 * 1024;

/** The `accept` list for a file input. */
export function acceptList(kind: FileKind, contentType: ContentType): string {
  return allowedFormats(kind, contentType)
    .flatMap((format) => [
      ...FILE_FORMATS[format].extensions.map((ext) => `.${ext}`),
      FILE_FORMATS[format].mime,
    ])
    .join(",");
}

export function formatsLabel(kind: FileKind, contentType: ContentType): string {
  return allowedFormats(kind, contentType).map((f) => FILE_FORMATS[f].label).join(", ");
}

export function formatLabelForMime(mime: string): string {
  return Object.values(FILE_FORMATS).find((f) => f.mime === mime)?.label ?? mime;
}

export const QC_FILE_MESSAGES = {
  missing: "Choose a file to upload.",
  empty: "That file is empty.",
  tooLarge: (limit: number) => `That file is too large. The limit here is ${formatBytes(limit)}.`,
  wrongType: (kind: FileKind, contentType: ContentType) =>
    `This area accepts ${formatsLabel(kind, contentType)} files.`,
  mismatch:
    "The file's name or type doesn't match what's inside it. Save it again in its proper format and retry.",
  macros: "Office files with macros can't be uploaded. Save it as a normal .docx or .xlsx file.",
  tooMany: (count: number) => `You can upload up to ${count} file${count === 1 ? "" : "s"} here. Remove one first.`,
} as const;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1].toLowerCase() : "";
}

export type UploadPlan = {
  format: FileFormat;
  mime: string;
  ext: string;
  fileName: string;
  maxBytes: number;
};

/** Step 1 — before anything is uploaded. */
export function checkUploadRequest(
  file: { name: string; size: number; type: string },
  kind: FileKind,
  contentType: ContentType,
  generalLimitBytes: number
): Checked<UploadPlan> {
  const fileName = cleanFileName(file.name);
  const ext = extensionOf(fileName);
  const format = allowedFormats(kind, contentType).find((f) =>
    (FILE_FORMATS[f].extensions as readonly string[]).includes(ext)
  );
  if (!format) return { ok: false, error: QC_FILE_MESSAGES.wrongType(kind, contentType) };

  const declared = file.type.split(";")[0].trim().toLowerCase();
  const acceptableDeclared = ["", "application/octet-stream", FILE_FORMATS[format].mime];
  if (format === "jpeg") acceptableDeclared.push("image/pjpeg");
  if (format === "mov") acceptableDeclared.push("video/mov");
  if (!acceptableDeclared.includes(declared)) return { ok: false, error: QC_FILE_MESSAGES.mismatch };

  const maxBytes = maxBytesFor(format, generalLimitBytes);
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, error: QC_FILE_MESSAGES.empty };
  if (file.size > maxBytes) return { ok: false, error: QC_FILE_MESSAGES.tooLarge(maxBytes) };

  return {
    ok: true,
    value: { format, mime: FILE_FORMATS[format].mime, ext: FILE_FORMATS[format].extensions[0], fileName, maxBytes },
  };
}

// ---------------------------------------------------------------------------
// Step 2 — recognising a format from a file's first bytes
// ---------------------------------------------------------------------------

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

function ascii(bytes: Uint8Array, from: number, to: number) {
  return String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)));
}

/** Does the byte sample contain this ASCII text? (Plain search — works in the browser too.) */
function contains(bytes: Uint8Array, text: string) {
  const needle = Array.from(text, (char) => char.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let odd = 0;
  for (const byte of bytes) {
    if (byte === 0) return false; // binary
    const control = byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c;
    if (control || byte === 0x7f) odd++;
  }
  return odd / bytes.length < 0.01;
}

const QUICKTIME_ATOMS = ["moov", "mdat", "wide", "free", "skip", "pnot"];

/**
 * Is `sample` (the start of a file) really `expected`? Returns an error
 * message or null. Office formats: DOCX / XLSX are ZIP packages with the
 * matching parts inside; DOC / XLS are OLE compound files. Macro-enabled
 * packages are refused.
 */
export function checkFormatBytes(expected: FileFormat, sample: Uint8Array): string | null {
  const isZip = startsWith(sample, [0x50, 0x4b, 0x03, 0x04]);
  const isOle = startsWith(sample, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const ftyp = ascii(sample, 4, 8) === "ftyp";

  switch (expected) {
    case "pdf":
      return contains(sample.subarray(0, 1024), "%PDF-") ? null : QC_FILE_MESSAGES.mismatch;
    case "docx":
    case "xlsx": {
      if (!isZip || !contains(sample, "[Content_Types].xml")) return QC_FILE_MESSAGES.mismatch;
      if (contains(sample, "vbaProject.bin")) return QC_FILE_MESSAGES.macros;
      return contains(sample, expected === "docx" ? "word/" : "xl/") ? null : QC_FILE_MESSAGES.mismatch;
    }
    case "doc":
    case "xls":
      return isOle ? null : QC_FILE_MESSAGES.mismatch;
    case "txt":
      return !isZip && !isOle && looksLikeText(sample) ? null : QC_FILE_MESSAGES.mismatch;
    case "jpeg":
      return startsWith(sample, [0xff, 0xd8, 0xff]) ? null : QC_FILE_MESSAGES.mismatch;
    case "png":
      return startsWith(sample, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? null : QC_FILE_MESSAGES.mismatch;
    case "webp":
      return ascii(sample, 0, 4) === "RIFF" && ascii(sample, 8, 12) === "WEBP" ? null : QC_FILE_MESSAGES.mismatch;
    case "mp4":
      return ftyp ? null : QC_FILE_MESSAGES.mismatch;
    case "mov":
      return ftyp || QUICKTIME_ATOMS.includes(ascii(sample, 4, 8)) ? null : QC_FILE_MESSAGES.mismatch;
    case "webm":
      return startsWith(sample, [0x1a, 0x45, 0xdf, 0xa3]) && contains(sample.subarray(0, 64), "webm")
        ? null
        : QC_FILE_MESSAGES.mismatch;
  }
}

/** Step 2 — after upload: the real bytes and the real size. */
export function checkUploadedFile(
  plan: Pick<UploadPlan, "format" | "maxBytes">,
  stored: { bytes: Uint8Array; totalSize: number }
): string | null {
  if (stored.totalSize <= 0 || stored.bytes.length === 0) return QC_FILE_MESSAGES.empty;
  if (stored.totalSize > plan.maxBytes) return QC_FILE_MESSAGES.tooLarge(plan.maxBytes);
  return checkFormatBytes(plan.format, stored.bytes);
}

/** The format a stored MIME type stands for (used when confirming an upload). */
export function formatForMime(mime: string): FileFormat | null {
  return (Object.keys(FILE_FORMATS) as FileFormat[]).find((f) => FILE_FORMATS[f].mime === mime) ?? null;
}
