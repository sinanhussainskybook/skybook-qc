import type { AnalysisRun } from "@/lib/db/analysis-runs";
import { cancelRun, failRun, finishRun, heartbeat } from "@/lib/db/analysis-runs";
import { insertExtractedRequirement, listFiles, listRequirements, touchSession } from "@/lib/db/qc-sessions";
import type { Company } from "@/lib/company/types";
import { containsText, findEmails, findPercentages, findPhones, findPrices, findWebsites, normalizeWords } from "@/lib/qc/compare";
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
 * Every candidate is stored UNCONFIRMED and OPTIONAL (source = extracted):
 * it is never used by QC until the designer reviews and confirms it.
 */

export const MAX_CANDIDATES_PER_RUN = 50;
const NOTE_PREFIX = "Found in";

type Candidate = { type: string; label: string | null; value: string; fileId: string; fileName: string };

const TYPE_LABELS = new Set<string>(REQUIREMENT_TYPES.map((t) => t.value));

/** Deterministic candidates (no AI). */
export function patternCandidates(text: string): Omit<Candidate, "fileId" | "fileName">[] {
  const out: Omit<Candidate, "fileId" | "fileName">[] = [];
  for (const p of findPhones(text)) out.push({ type: "phone", label: null, value: p });
  for (const e of findEmails(text)) out.push({ type: "email", label: null, value: e });
  for (const w of findWebsites(text)) out.push({ type: "website", label: null, value: w });
  for (const p of findPrices(text)) out.push({ type: "price", label: null, value: p.text });
  for (const n of new Set(findPercentages(text))) out.push({ type: "percentage", label: null, value: `${n}%` });
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
    await cancelRun(deps.db, run.id, SAFE_REASONS.changed, now());
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
    await heartbeat(deps.db, run.id, now(), progress);
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
    await heartbeat(deps.db, run.id, now(), progress);
    if (proposed && !proposed.ok) problems.push(`${file.file_name}: ${proposed.reason}`);
    if (proposed?.ok) {
      for (const c of proposed.value.candidates) {
        // No invention: the value and the quote must both be in the file's own text.
        if (!containsText(text, c.value) || !containsText(text, c.quote)) continue;
        candidates.push({ type: c.type, label: c.label, value: c.value, fileId: file.id, fileName: file.file_name });
      }
    }
  }

  if (!readable) {
    return (await failRun(deps.db, run.id, (problems[0] ?? SAFE_REASONS.failed).slice(0, 300), now())) ? "failed" : "lost";
  }
  if (!(await authorizeRun(deps.db, run, now()))) {
    await cancelRun(deps.db, run.id, SAFE_REASONS.unavailable, now());
    return "cancelled";
  }

  // Skip anything already in the session (typed or found before) and duplicates.
  const existing = new Set((await listRequirements(deps.db, access.sessionId)).map((r) => `${r.type}|${normalizeWords(r.expected_value)}`));
  let added = 0;
  for (const c of candidates) {
    const key = `${c.type}|${normalizeWords(c.value)}`;
    if (existing.has(key) || added >= MAX_CANDIDATES_PER_RUN) continue;
    existing.add(key);
    await insertExtractedRequirement(
      deps.db,
      access.sessionId,
      {
        type: c.type,
        label: c.label?.slice(0, 120) ?? null,
        expectedValue: c.value.slice(0, 2000),
        notes: `${NOTE_PREFIX} ${c.fileName}`.slice(0, 1000),
        sourceFileId: c.fileId,
      },
      now()
    );
    added++;
  }
  if (added) await touchSession(deps.db, access.sessionId, now());
  return (await finishRun(deps.db, run.id, {}, now())) ? "done" : "lost";
}
