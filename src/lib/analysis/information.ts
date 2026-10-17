import type { AnalysisRun } from "@/lib/db/analysis-runs";
import { cancelRun, failRun, finishRun, heartbeat } from "@/lib/db/analysis-runs";
import { insertExtractedRequirement, listFiles, listRequirements, touchSession } from "@/lib/db/qc-sessions";
import type { Company } from "@/lib/company/types";
import {
  containsText,
  findEmails,
  findExactSize,
  findPercentages,
  findPhones,
  findPrices,
  findWebsites,
  normalizeWords,
  parseDimensions,
  sizeText,
} from "@/lib/qc/compare";
import { REQUIREMENT_TYPES } from "@/lib/qc/requirements";
import { callProvider, RunAborted } from "@/lib/analysis/call";
import { docxText, plainText, xlsxText } from "@/lib/analysis/documents";
import { ANALYSIS_LIMITS } from "@/lib/analysis/limits";
import { prepareImage } from "@/lib/analysis/media/images";
import { renderPdfPages, pdfText } from "@/lib/analysis/media/pdf";
import { authorizeRun, filesFingerprint, limitsOf, SAFE_REASONS, type RunDeps } from "@/lib/analysis/pipeline";
import { ocrValidator, validateRequirementCandidates } from "@/lib/analysis/validate";

/**
 * Reading requirements out of uploaded information files (plan 6.7; from
 * 4.5 / 4.6). For each file: read its text locally (TXT, DOCX, XLSX, PDF text
 * layer); scanned PDF pages and images are read by OCR. Then:
 *   1. pattern rules (no AI): phone, email, website, price, percentage;
 *   2. the AI proposes more — and a proposal is kept ONLY when its value and
 *      its quote appear word for word in the file's text (no invention).
 * Every candidate is stored UNCONFIRMED (source = extracted): it is never used
 * by QC until the designer presses Check Design (descriptive items never are).
 * Price, CTA, headline, disclaimer and dimensions start as Must have. A
 * product or service name is Must have only when the brief explicitly asks
 * for that exact name — by its wording or by listing it under a required-
 * content heading (explicitlyRequired); otherwise it is description. The
 * rest start Optional.
 */

export const MAX_CANDIDATES_PER_RUN = 50;
/** Extracted requirements of these kinds start as Must have (mandatory). */
export const MUST_HAVE_TYPES: ReadonlySet<string> = new Set(["price", "cta", "headline", "disclaimer", "dimensions"]);
const NOTE_PREFIX = "Found in";

type Candidate = { type: string; label: string | null; value: string; fileId: string; fileName: string; explicit?: boolean };

/** Names a brief may only describe: Must have only when it explicitly asks for the exact name. */
const NAME_TYPES: ReadonlySet<string> = new Set(["product_name", "service_name"]);

/** Wording that makes a name an exact requirement rather than a description. */
const EXACT_WORDING =
  /\b(?:must|mandatory|required|exact(?:ly)?|verbatim|word[- ]for[- ]word|as written|as spelt|as spelled|has to|have to|needs? to)\b/i;

/**
 * Section headings in a brief (short lines): one that marks REQUIRED content
 * ("Required Content", "Required Value", "Required Text", "Mandatory…", "Must
 * have / include…"), and one that starts a descriptive section. A bare
 * "Requirements" title is neither — it heads the whole brief.
 */
const REQUIRED_HEADING = /^(?:required\s+(?:content|value|values|text|copy|elements|items|information|details)|mandatory\b|compulsory\b|must[- ](?:have|haves|include|appear|show)\b)/i;
const OTHER_HEADING =
  /^(?:(?:additional|general|further|more|other)\s+)?(?:special\s+instructions?|instructions?|notes?|company\s+(?:information|info|details|profile)|background|about\b|context|overview|descriptions?|campaign\b|purpose|objectives?|target\s+audience|audience|optional|nice\s+to\s+have|tone|style|brand\s+guidelines?|deliverables?|references?|not\s+specified|product\s+(?:information|details)|service\s+(?:information|details))/i;
const HEADING_MAX_LENGTH = 60;

/** Is line `index` under a required-content heading (the nearest heading above it, or on it)? */
function underRequiredHeading(lines: string[], index: number): boolean {
  for (let i = index; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line.length > HEADING_MAX_LENGTH) continue;
    if (REQUIRED_HEADING.test(line)) return true;
    if (OTHER_HEADING.test(line)) return false;
  }
  return false; // no heading at all: description
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does the brief explicitly require this exact name on the design? Read from
 * the brief's own words and layout — no AI judgement:
 *   - the name is in quotation marks ("Palm Residence", “Palm Residence”), or
 *   - the line that gives it (or the AI's quote / label for it) says it must
 *     be exact — "must", "required", "mandatory", "exactly", "as written"…, or
 *   - it is listed under a required-content heading: the nearest heading above
 *     it is "Required Content" / "Required Value" / "Mandatory…" (Travel Mart's
 *     "Required Content" table), not "Background", "Company Information"…
 * The name's own words are left out of the wording test ("Required Gear" is a
 * name, not an instruction). Anything else — a name mentioned in a background
 * paragraph, a company-information section, or a brief with no headings —
 * stays description.
 */
export function explicitlyRequired(text: string, value: string, context: (string | null | undefined)[] = []): boolean {
  const name = value.trim();
  if (!name) return false;
  const quoted = new RegExp(`["“”„«»]\\s*${escapeRegExp(name)}\\s*["“”„«»]`, "i");
  if (quoted.test(text)) return true;
  const without = (line: string) => line.replace(new RegExp(escapeRegExp(name), "gi"), " ");
  const all = text.split(/\r?\n/);
  const at = all.flatMap((line, i) => (containsText(line, name) ? [i] : []));
  if (at.some((i) => underRequiredHeading(all, i))) return true;
  const lines = at.map((i) => all[i]);
  return [...lines, ...context.filter((c): c is string => Boolean(c))].some((line) => EXACT_WORDING.test(without(line)));
}

const TYPE_LABELS = new Set<string>(REQUIREMENT_TYPES.map((t) => t.value));

/** Deterministic candidates (no AI). */
export function patternCandidates(text: string): Omit<Candidate, "fileId" | "fileName">[] {
  const out: Omit<Candidate, "fileId" | "fileName">[] = [];
  for (const p of findPhones(text)) out.push({ type: "phone", label: null, value: p });
  for (const e of findEmails(text)) out.push({ type: "email", label: null, value: e });
  for (const w of findWebsites(text)) out.push({ type: "website", label: null, value: w });
  for (const p of findPrices(text)) out.push({ type: "price", label: null, value: p.text });
  for (const n of new Set(findPercentages(text))) out.push({ type: "percentage", label: null, value: `${n}%` });
  // The brief's exact size, as the brief writes it — so it never depends on the AI copying the "×".
  const size = findExactSize(text);
  if (size) out.push({ type: "dimensions", label: null, value: sizeText(size) });
  return out;
}

async function readFileText(
  deps: RunDeps,
  file: { id: string; file_name: string; mime_type: string },
  bytes: Uint8Array,
  signal: AbortSignal
): Promise<{ text: string } | { unsupported: string }> {
  switch (file.mime_type) {
    case "text/plain":
      return { text: plainText(bytes) };
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      const text = docxText(bytes);
      return text === null ? { unsupported: "the Word file couldn't be read" } : { text };
    }
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
      const text = xlsxText(bytes);
      return text === null ? { unsupported: "the Excel file couldn't be read" } : { text };
    }
    case "application/msword":
    case "application/vnd.ms-excel":
      return { unsupported: "old .doc / .xls files can't be read — save it as .docx / .xlsx, or add the requirements by hand" };
    case "application/pdf": {
      const layer = await pdfText(bytes, ANALYSIS_LIMITS.maxInformationPagesPerFile);
      if ("unsupported" in layer) return layer;
      const pages = [...layer.pages];
      // Scanned pages (no text layer) are read by OCR.
      const scanned = pages.map((t, i) => (t.trim().length < 20 ? i : -1)).filter((i) => i >= 0);
      if (scanned.length) {
        const rendered = await renderPdfPages(bytes, ANALYSIS_LIMITS.maxInformationPagesPerFile);
        if (!("unsupported" in rendered)) {
          for (const i of scanned) {
            const page = rendered.pages[i];
            if (page) pages[i] = (await ocrText(deps, page.png, `${file.id}#p${i + 1}`, file.file_name, signal)) ?? pages[i];
          }
        }
      }
      return { text: pages.join("\n") };
    }
    default:
      if (file.mime_type.startsWith("image/")) {
        const text = await ocrText(deps, bytes, file.id, file.file_name, signal);
        return text === null ? { unsupported: "the image's text couldn't be read" } : { text };
      }
      return { unsupported: "this kind of file can't be read" };
  }
}

async function ocrText(deps: RunDeps, bytes: Uint8Array, key: string, sourceName: string, signal: AbortSignal): Promise<string | null> {
  const limits = limitsOf(deps);
  const image = await prepareImage(bytes, key, limits.ocrImageLongEdge, sourceName).catch(() => null);
  if (!image) return null;
  const read = await callProvider(
    (s) => deps.provider.readText(image, s),
    (raw) => ocrValidator(deps.provider)(raw, image.width, image.height),
    { timeoutMs: limits.ocrTimeoutMs, runSignal: signal, sleep: deps.sleep, retries: limits.maxCallRetries, retryTimeouts: limits.retryTimeouts, provider: deps.provider.name }
  );
  return read.ok ? read.value.blocks.map((b) => b.text).join("\n") : null;
}

export async function processInformationRun(
  deps: RunDeps,
  run: AnalysisRun,
  access: { company: Company; sessionId: string },
  signal: AbortSignal,
  progress: { stage: string; done: number; total: number }
): Promise<"done" | "failed" | "cancelled" | "lost"> {
  const now = deps.now ?? (() => new Date());
  const limits = limitsOf(deps);
  const files = (await listFiles(deps.db, access.sessionId, "ready")).filter((f) => f.kind === "information").slice(0, limits.maxImagesPerRun);
  if (filesFingerprint(files) !== run.files_fingerprint) {
    await cancelRun(deps.db, run, SAFE_REASONS.changed, now());
    return "cancelled";
  }
  progress.total = files.length * 2;
  progress.done = 0;
  const candidates: Candidate[] = [];
  const problems: string[] = [];
  let readable = 0;

  for (const file of files) {
    if (signal.aborted) throw new RunAborted();
    progress.stage = "Reading information files";
    const stored = await deps.storage.readStart(file.storage_path, file.file_size + 1);
    const read = stored ? await readFileText(deps, file, stored.bytes, signal) : { unsupported: "the file couldn't be read from storage" };
    progress.done++;
    await heartbeat(deps.db, run, now(), progress);
    if ("unsupported" in read) {
      problems.push(`${file.file_name}: ${read.unsupported}`);
      continue;
    }
    readable++;
    const text = read.text.slice(0, limits.maxExtractionChars);
    for (const c of patternCandidates(text)) candidates.push({ ...c, fileId: file.id, fileName: file.file_name });

    progress.stage = "Finding requirements";
    const proposed = text.trim()
      ? await callProvider(
          (s) => deps.provider.extractRequirements({ text, allowedTypes: [...TYPE_LABELS], sourceName: file.file_name }, s),
          validateRequirementCandidates,
          { timeoutMs: limits.extractTimeoutMs, runSignal: signal, sleep: deps.sleep, retries: limits.maxCallRetries, retryTimeouts: limits.retryTimeouts, provider: deps.provider.name }
        )
      : null;
    progress.done++;
    await heartbeat(deps.db, run, now(), progress);
    if (proposed && !proposed.ok) problems.push(`${file.file_name}: ${proposed.reason}`);
    if (proposed?.ok) {
      for (const c of proposed.value.candidates) {
        // No invention: the value and the quote must both be in the file's own text.
        if (!containsText(text, c.value) || !containsText(text, c.quote)) continue;
        // A size the AI copied without its "×" ("1080  1080 px") is stored the standard way.
        const size = c.type === "dimensions" ? parseDimensions(c.value) : null;
        const value = size ? sizeText(size) : c.value;
        const explicit = NAME_TYPES.has(c.type) && explicitlyRequired(text, c.value, [c.quote, c.label]);
        candidates.push({ type: c.type, label: c.label, value, fileId: file.id, fileName: file.file_name, explicit });
      }
    }
  }

  if (!readable) {
    return (await failRun(deps.db, run, (problems[0] ?? SAFE_REASONS.failed).slice(0, 300), now())) ? "failed" : "lost";
  }
  if (!(await authorizeRun(deps.db, run, now()))) {
    await cancelRun(deps.db, run, SAFE_REASONS.unavailable, now());
    return "cancelled";
  }

  // Skip anything already in the session (typed or found before) and duplicates.
  const existing = new Set((await listRequirements(deps.db, access.sessionId)).map((r) => `${r.type}|${normalizeWords(r.expected_value)}`));
  let added = 0;
  for (const c of candidates) {
    const key = `${c.type}|${normalizeWords(c.value)}`;
    if (existing.has(key) || added >= MAX_CANDIDATES_PER_RUN) continue;
    existing.add(key);
    const inserted = await insertExtractedRequirement(
      deps.db,
      access.sessionId,
      {
        type: c.type,
        label: c.label?.slice(0, 120) ?? null,
        expectedValue: c.value.slice(0, 2000),
        notes: `${NOTE_PREFIX} ${c.fileName}`.slice(0, 1000),
        sourceFileId: c.fileId,
        mandatory: MUST_HAVE_TYPES.has(c.type) || Boolean(c.explicit),
      },
      now(),
      run
    );
    if (!inserted) return "lost"; // this run was recovered or claimed again: the newer attempt adds them
    added++;
  }
  if (added) await touchSession(deps.db, access.sessionId, now());
  return (await finishRun(deps.db, run, {}, now())) ? "done" : "lost";
}
