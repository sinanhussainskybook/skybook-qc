import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeBucket } from "../../../test/fake-storage";
import sharp from "sharp";
import type { Database } from "@/lib/db/database";
import type { User } from "@/lib/db/users";
import { insertCompany } from "@/lib/db/companies";
import { claimNextRun, findRun, insertRun } from "@/lib/db/analysis-runs";
import { insertPendingFile, insertSession, listFiles, listRequirements, markFileReady, type QcSession } from "@/lib/db/qc-sessions";
import { GEMINI_LIMITS, LOCAL_LIMITS, type AnalysisLimits } from "@/lib/analysis/limits";
import { PassThroughPreparer } from "@/lib/analysis/media/types";
import { MockProvider } from "@/lib/analysis/mock-provider";
import { filesFingerprint, processRun } from "@/lib/analysis/pipeline";
import type { AnalysisProvider } from "@/lib/analysis/provider";
import { BRIEF_TOO_LONG_PREFIX, isOversizedBriefReason, oversizedBriefMessage } from "@/lib/qc/brief-length";
import { briefTooLongHold } from "@/lib/analysis/enqueue";
import { readinessProblems } from "@/lib/qc/session";

/**
 * Stage 2 safeguard: with Local AI, an uploaded brief longer than it reads (12,000 characters on a CPU)
 * is never read in part — every format, every file; the message names the files. Gemini is unchanged.
 */

const LIMIT = LOCAL_LIMITS.cpu.maxExtractionChars; // 12,000
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const docx = (text: string) =>
  zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`) });
const xlsx = (text: string) =>
  zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/sharedStrings.xml": strToU8(`<sst><si><t>${text}</t></si></sst>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1"><c t="s"><v>0</v></c></row></sheetData></worksheet>`),
  });
/** A one-page PDF with a text layer: `text` in lines of 100 characters (6 pt, all on the page). */
function textPdf(text: string): Uint8Array {
  const lines = text.match(/.{1,100}/g) ?? [];
  const stream = `BT /F1 6 Tf 10 830 Td ${lines.map((l, i) => `${i ? "0 -6 Td " : ""}(${l}) Tj`).join(" ")} ET`;
  const objects = [
    "",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
/** A brief of exactly `n` characters, with a phone number up front (found by the pattern rules). */
const brief = (n: number) => {
  const head = "Call +971 4 123 4567 ";
  return head + "x".repeat(n - head.length);
};

describe("brief too long for Local AI: the message", () => {
  it("names the file, the limit and what to do; at most two names, then 'and N more'; always within 300 characters", () => {
    expect(oversizedBriefMessage([{ name: "brief.pdf", chars: 15_230 }], 12_000)).toBe(
      "Too long for Local AI to read in full: brief.pdf (15,230 characters). Local AI reads up to 12,000 characters per brief file — shorten it, or split it into smaller files and upload them separately."
    );
    const many = oversizedBriefMessage(
      [
        { name: `${"a".repeat(250)}.docx`, chars: 40_000 },
        { name: "b.pdf", chars: 13_000 },
        { name: "c.txt", chars: 12_001 },
        { name: "d.txt", chars: 99_999 },
      ],
      12_000
    );
    expect(many.length).toBeLessThanOrEqual(300);
    expect(many).toMatch(/^Too long for Local AI to read in full: a{29}… \(40,000 characters\), b\.pdf \(13,000 characters\) and 2 more\. .*shorten each, or split each into smaller files and upload them separately\.$/);
    expect(isOversizedBriefReason(many)).toBe(true);
    expect(isOversizedBriefReason("The analysis couldn't read the content.")).toBe(false);
    expect(isOversizedBriefReason(null)).toBe(false);
  });
});

describe("brief too long for Local AI: the brief reading", () => {
  let db: Database;
  let close: () => Promise<void>;
  let dee: User;
  let acme: string;
  let session: QcSession;
  let fake: ReturnType<typeof createFakeBucket>;
  let tempRoot: string;
  let extracted: string[];
  const T0 = new Date("2026-11-10T09:00:00Z");

  beforeAll(async () => {
    const test = await createTestDatabase();
    db = test.db;
    close = test.close;
    dee = await insertTestUser(db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    acme = (await insertCompany(db, { name: "Acme", createdBy: dee.id })).id;
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "qc-info-length-"));
  });
  afterAll(() => close());
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake = createFakeBucket();
    extracted = [];
    await db.query("delete from qc_sessions");
    session = (await insertSession(db, { companyId: acme, userId: dee.id, contentType: "social_post" }, T0))!;
  });

  let added = 0;
  async function addInfo(name: string, mime: string, ext: string, bytes: Uint8Array) {
    const id = crypto.randomUUID();
    const storagePath = `${session.id}/${id}.${ext}`;
    // One second apart, so files are read in the order they were added.
    const at = new Date(T0.getTime() + ++added * 1000);
    await insertPendingFile(db, session.id, { id, kind: "information", fileName: name, storagePath, mimeType: mime, fileSize: bytes.length }, at);
    await markFileReady(db, session.id, id, bytes.length, T0);
    fake.files.set(storagePath, bytes);
    return id;
  }
  const addTxt = (name: string, text: string) => addInfo(name, "text/plain", "txt", strToU8(text));

  /** The mock's answers, under another provider's name; image text read as `ocrLines`; extraction calls recorded. */
  function provider(name: "local" | "gemini", ocrLines: string[] = []): AnalysisProvider {
    const mock = new MockProvider();
    return {
      ...mock,
      name,
      label: mock.label,
      ocrFormat: "gemini-v1",
      readText: async () => JSON.stringify({ texts: ocrLines.map((text) => ({ text, box_2d: null, certainty: "clear" })) }),
      judgeImage: mock.judgeImage.bind(mock),
      transcribe: mock.transcribe.bind(mock),
      extractRequirements: async (input, signal) => {
        extracted.push(input.sourceName ?? "");
        return mock.extractRequirements(input, signal);
      },
    } as AnalysisProvider;
  }
  async function read(p: AnalysisProvider, limits: AnalysisLimits = LOCAL_LIMITS.cpu) {
    const files = (await listFiles(db, session.id, "ready")).filter((f) => f.kind === "information");
    // Each reading later than the one before (as in real use), so "newest" is well defined.
    await insertRun(db, { sessionId: session.id, userId: dee.id, kind: "information", provider: "mock", fingerprint: filesFingerprint(files) }, new Date(T0.getTime() + ++added * 1000));
    const claimed = (await claimNextRun(db, T0, "mock"))!;
    const result = await processRun({ db, storage: fake.bucket, logoStorage: null, provider: p, preparer: new PassThroughPreparer(), tempRoot, limits, now: () => T0, sleep: async () => {} }, claimed);
    return { result, run: (await findRun(db, claimed.id))! };
  }

  it("below the limit: read as before", async () => {
    await addTxt("brief.txt", brief(LIMIT - 1));
    expect((await read(provider("local"))).result).toBe("done");
    expect((await listRequirements(db, session.id)).map((r) => r.expected_value)).toContain("+971 4 123 4567");
    expect(extracted).toEqual(["brief.txt"]);
  });

  it("exactly at the limit: read in full (a final line break, as a typed brief has, doesn't count)", async () => {
    await addTxt("brief.txt", brief(LIMIT));
    await addTxt("Typed brief.txt", `${brief(LIMIT)}\n`);
    expect((await read(provider("local"))).result).toBe("done");
    expect(extracted.sort()).toEqual(["Typed brief.txt", "brief.txt"]);
  });

  it("one character over: not read in part — the reading stops naming the file, no requirements, no AI extraction", async () => {
    await addTxt("brief.txt", brief(LIMIT + 1));
    const { result, run } = await read(provider("local"));
    expect(result).toBe("failed");
    expect(run.failure_reason).toBe(oversizedBriefMessage([{ name: "brief.txt", chars: LIMIT + 1 }], LIMIT));
    expect(await listRequirements(db, session.id)).toEqual([]);
    expect(extracted).toEqual([]);
  });

  it("several files: every long one is named; the short ones aren't used on their own either (never part of the brief)", async () => {
    await addTxt("a-short.txt", "Email sales@skybook.com");
    await addTxt("b-long.txt", brief(15_000));
    await addTxt("c-short.txt", "Website www.skybook.com");
    await addTxt("d-long.txt", brief(LIMIT + 500));
    const { result, run } = await read(provider("local"));
    expect(result).toBe("failed");
    expect(run.failure_reason).toContain("b-long.txt (15,000 characters)");
    expect(run.failure_reason).toContain("d-long.txt (12,500 characters)");
    expect(run.failure_reason).not.toContain("a-short");
    expect(run.failure_reason).not.toContain("c-short");
    expect(await listRequirements(db, session.id)).toEqual([]);
    // Nothing more is sent to the AI once a long file is found (the file before it was already read).
    expect(extracted).toEqual(["a-short.txt"]);
  });

  it("split into smaller files (each within the limit) and uploaded separately: all read", async () => {
    await addTxt("brief part 1.txt", brief(LIMIT));
    await addTxt("brief part 2.txt", `Email sales@skybook.com ${"y".repeat(5_000)}`);
    expect((await read(provider("local"))).result).toBe("done");
    expect((await listRequirements(db, session.id)).map((r) => r.expected_value)).toEqual(expect.arrayContaining(["+971 4 123 4567", "sales@skybook.com"]));
  });

  it("every brief format is measured after its text is read: DOCX, XLSX, PDF, TXT and images", async () => {
    const long = "z".repeat(LIMIT + 1_000);
    // A real image (its text is read by the AI: here 7 lines of 2,000 characters — 14,006 in all).
    const photo = new Uint8Array(await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ffffff" } }).png().toBuffer());
    await addInfo("brief.docx", DOCX, "docx", docx(long));
    await addInfo("sheet.xlsx", XLSX, "xlsx", xlsx(long));
    await addInfo("brief.pdf", "application/pdf", "pdf", textPdf(long));
    await addTxt("notes.txt", long);
    await addInfo("photo.png", "image/png", "png", photo);
    const ocr = Array.from({ length: 7 }, () => "w".repeat(2_000));
    const { result, run } = await read(provider("local", ocr));
    expect(result).toBe("failed");
    // All five are too long: the first two are named, then "and 3 more".
    expect(run.failure_reason).toMatch(/^Too long for Local AI to read in full: brief\.docx \(13,000 characters\), sheet\.xlsx \(13,000 characters\) and 3 more\./);
    // Each format on its own.
    for (const [name, mime, ext, bytes] of [
      ["brief.docx", DOCX, "docx", docx(long)],
      ["sheet.xlsx", XLSX, "xlsx", xlsx(long)],
      ["brief.pdf", "application/pdf", "pdf", textPdf(long)],
      ["notes.txt", "text/plain", "txt", strToU8(long)],
      ["photo.png", "image/png", "png", photo],
    ] as const) {
      await db.query("delete from qc_sessions");
      session = (await insertSession(db, { companyId: acme, userId: dee.id, contentType: "social_post" }, T0))!;
      await addInfo(name, mime, ext, bytes);
      const alone = await read(provider("local", ocr));
      expect(alone.result, name).toBe("failed");
      expect(alone.run.failure_reason, name).toContain(`${BRIEF_TOO_LONG_PREFIX}: ${name} (`);
    }
  });

  it("Gemini (and the other providers): unchanged — a long brief is read as before, no stop", async () => {
    await addTxt("brief.txt", brief(70_000));
    const { result } = await read(provider("gemini"), GEMINI_LIMITS);
    expect(result).toBe("done");
    expect((await listRequirements(db, session.id)).map((r) => r.expected_value)).toContain("+971 4 123 4567");
  });

  it("the hold: kept by real readings that fail or are cancelled, even with the long file removed; lifted only by a reading that finishes", async () => {
    const longId = await addTxt("brief.txt", brief(LIMIT + 1));
    const { run } = await read(provider("local"));
    const reason = run.failure_reason!;
    expect(await briefTooLongHold(db, session.id)).toBe(reason);
    expect(readinessProblems([], await listFiles(db, session.id, "ready"), undefined, { briefTooLong: reason })).toContain(reason);
    // The long file removed: still held.
    await db.query("delete from qc_files where id = $1", [longId]);
    expect(await briefTooLongHold(db, session.id)).toBe(reason);
    // A newer reading that fails for another reason (a Word file that can't be read): still held.
    const broken = await addInfo("broken.docx", DOCX, "docx", new Uint8Array([1, 2, 3]));
    const failed = await read(provider("local"));
    expect(failed.result).toBe("failed");
    expect(failed.run.failure_reason).toContain("broken.docx");
    expect(await briefTooLongHold(db, session.id)).toBe(reason);
    // A newer reading cancelled because the files changed while it waited: still held.
    await db.query("delete from qc_files where id = $1", [broken]);
    await addTxt("brief part 1.txt", brief(LIMIT));
    await insertRun(db, { sessionId: session.id, userId: dee.id, kind: "information", provider: "mock", fingerprint: "stale" }, new Date(T0.getTime() + ++added * 1000));
    const stale = (await claimNextRun(db, T0, "mock"))!;
    expect(await processRun({ db, storage: fake.bucket, logoStorage: null, provider: provider("local"), preparer: new PassThroughPreparer(), tempRoot, limits: LOCAL_LIMITS.cpu, now: () => T0, sleep: async () => {} }, stale)).toBe("cancelled");
    expect(await briefTooLongHold(db, session.id)).toBe(reason);
    // Read again successfully (the split brief): lifted.
    const again = await read(provider("local"));
    expect(again.result).toBe("done");
    expect(await briefTooLongHold(db, session.id)).toBeNull();
  });
});
