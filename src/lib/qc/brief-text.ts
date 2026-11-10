import type { Checked } from "@/lib/qc/qc-file";

/**
 * A brief typed or pasted into step 1 (instead of, or as well as, an uploaded file). The server saves it
 * as a plain-text information file (`Typed brief.txt`) in the session's own temporary folder, so it is
 * checked, stored, read, confirmed and deleted exactly like an uploaded .txt brief. These checks run in
 * the browser (instant feedback) and again on the server (the only ones that count).
 */

/** About 8–10 pages of text. Longer briefs are uploaded as a file instead. */
export const BRIEF_TEXT_MAX_CHARS = 20_000;

export const BRIEF_TEXT_FILE_NAME = "Typed brief";

export const BRIEF_TEXT_MESSAGES = {
  empty: "Type or paste the brief first.",
  noWords: "The brief text needs some words or numbers.",
  tooLong: (length: number) =>
    `The brief text is too long (${length.toLocaleString("en-GB")} characters). The limit is ${BRIEF_TEXT_MAX_CHARS.toLocaleString("en-GB")} — upload it as a file instead.`,
  /** Local AI reads only the first part of each brief: longer text is refused, never cut short unseen. */
  beyondReading: (length: number, max: number) =>
    `The brief text is ${length.toLocaleString("en-GB")} characters, but Local AI reads only the first ${max.toLocaleString("en-GB")} characters of each brief, so the rest would be missed. Shorten it, or save it in parts — each part is read in full.`,
  /** The request itself failed (e.g. a paste far too large to send, or the connection dropped). */
  notSent: "The brief text couldn't be sent. Check your connection and try again.",
} as const;

/** Local AI's warning for uploaded briefs (shown on Start QC only when the AI reads less than a full brief). */
export const localReadingNote = (max: number) =>
  `Local AI reads only the first ${max.toLocaleString("en-GB")} characters of each brief file or typed brief. If a brief is longer, split it into separate files or typed parts so nothing is missed.`;

/**
 * How long a typed brief may be: 20,000 characters, or less when the AI reads less of a brief than that
 * (Local AI on a CPU: 12,000) — so a typed brief is always read in full.
 */
export function briefTextLimit(readingChars: number): number {
  return Math.min(BRIEF_TEXT_MAX_CHARS, Math.max(1, Math.floor(readingChars)));
}

/**
 * Tidies pasted text without changing what it says: one kind of line break, no invisible control
 * characters (they would make the saved file look binary), no trailing spaces, at most two blank lines
 * in a row, nothing blank at either end.
 */
export function normalizeBriefText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\ufeff]/g, (c) => (c === "\f" || c === "\v" ? "\n" : ""))
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/** The brief text to save, or why it can't be saved. `maxChars`: briefTextLimit for the configured AI. */
export function checkBriefText(raw: unknown, maxChars: number = BRIEF_TEXT_MAX_CHARS): Checked<string> {
  const text = normalizeBriefText(typeof raw === "string" ? raw : "");
  if (!text) return { ok: false, error: BRIEF_TEXT_MESSAGES.empty };
  if (text.length > BRIEF_TEXT_MAX_CHARS) return { ok: false, error: BRIEF_TEXT_MESSAGES.tooLong(text.length) };
  if (text.length > maxChars) return { ok: false, error: BRIEF_TEXT_MESSAGES.beyondReading(text.length, maxChars) };
  if (!/[\p{L}\p{N}]/u.test(text)) return { ok: false, error: BRIEF_TEXT_MESSAGES.noWords };
  return { ok: true, value: text };
}

/** "Typed brief.txt", then "Typed brief 2.txt", … — never the same name as one already in the session. */
export function briefTextFileName(existing: readonly string[]): string {
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${BRIEF_TEXT_FILE_NAME}.txt` : `${BRIEF_TEXT_FILE_NAME} ${n}.txt`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}
