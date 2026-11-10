/**
 * Uploaded briefs longer than Local AI reads (Stage 2 safeguard). The brief reading measures each
 * file's extracted text — every format: TXT, DOCX, XLSX, PDF (text and scanned pages), images. With
 * Local AI, a file longer than its reading limit is never read in part: the reading stops with this
 * message, naming the files, no requirements are added, and Check Design waits until the brief is
 * shortened or split. Gemini (and the other providers) are unchanged. Safe for the browser.
 */

/** How the stored reason starts — how the page recognises it. */
export const BRIEF_TOO_LONG_PREFIX = "Too long for Local AI to read in full";

/** Stored reasons are at most this long (qc_analysis_runs.failure_reason, failRun). */
const REASON_MAX = 300;
const NAME_MAX = 30;
const SHOWN_FILES = 2;

const shortName = (name: string) => ([...name].length > NAME_MAX ? `${[...name].slice(0, NAME_MAX - 1).join("")}…` : name);
const count = (n: number) => n.toLocaleString("en-GB");

/**
 * "Too long for Local AI to read in full: brief.pdf (15,230 characters). Local AI reads up to 12,000
 * characters per brief file — shorten it, or split it into smaller files and upload them separately."
 * Two file names at most (then "and N more"), each shortened to 30 characters, so the advice always fits
 * within the stored reason's 300 characters.
 */
export function oversizedBriefMessage(files: readonly { name: string; chars: number }[], max: number): string {
  const listed = files.slice(0, SHOWN_FILES).map((f) => `${shortName(f.name)} (${count(f.chars)} characters)`);
  const more = files.length > SHOWN_FILES ? ` and ${files.length - SHOWN_FILES} more` : "";
  const it = files.length === 1 ? "it" : "each";
  const message =
    `${BRIEF_TOO_LONG_PREFIX}: ${listed.join(", ")}${more}. Local AI reads up to ${count(max)} characters per brief file — ` +
    `shorten ${it}, or split ${it} into smaller files and upload them separately.`;
  return message.length <= REASON_MAX ? message : `${message.slice(0, REASON_MAX - 1)}…`;
}

/** A brief reading stopped because brief files were added or removed while it ran (nothing was saved). */
export const BRIEF_FILES_CHANGED_MESSAGE = "The brief files changed while they were being read — read the updated brief again.";

export function isOversizedBriefReason(reason: string | null | undefined): reason is string {
  return typeof reason === "string" && reason.startsWith(BRIEF_TOO_LONG_PREFIX);
}
