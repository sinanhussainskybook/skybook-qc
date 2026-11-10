import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeBucket } from "../../../test/fake-storage";
import { PNG } from "../../../test/logo-files";
import type { Database } from "@/lib/db/database";
import type { User } from "@/lib/db/users";
import { findAccessibleCompany, insertCompany } from "@/lib/db/companies";
import { claimNextRun, insertRun } from "@/lib/db/analysis-runs";
import { listFiles, listRequirements, type QcSession } from "@/lib/db/qc-sessions";
import { PassThroughPreparer } from "@/lib/analysis/media/types";
import { MockProvider } from "@/lib/analysis/mock-provider";
import { filesFingerprint, processRun } from "@/lib/analysis/pipeline";
import {
  BRIEF_TEXT_MAX_CHARS,
  BRIEF_TEXT_MESSAGES,
  briefTextFileName,
  checkBriefText,
  normalizeBriefText,
} from "@/lib/qc/brief-text";
import { QC_FILE_MESSAGES } from "@/lib/qc/qc-file";
import { loadQcInput } from "@/lib/qc/qc-input";
import {
  confirmUpload,
  markReady,
  prepareUpload,
  purgeExpiredSessions,
  READINESS_MESSAGES,
  readinessProblems,
  removeFile,
  saveBriefText,
  SESSION_MESSAGES,
  startSession,
} from "@/lib/qc/session";

/** Stage 2 — a typed or pasted brief goes through the same storage, brief reading and confirmation as an uploaded one. */

describe("brief text: checks", () => {
  it("tidies pasted text without changing what it says", () => {
    expect(normalizeBriefText("﻿  Headline: Sale\r\nPrice AED 99  \r\n\r\n\r\n\r\n\r\nCall 123\u0000\u0007\t ")).toBe("Headline: Sale\nPrice AED 99\n\n\nCall 123");
    expect(normalizeBriefText("Line one\fLine two")).toBe("Line one\nLine two");
    expect(normalizeBriefText("Ünïcödé — 20% off · ١٢٣")).toBe("Ünïcödé — 20% off · ١٢٣");
  });

  it("empty, blank, symbols only, not text, too long → a clear message; the limit itself is fine", () => {
    for (const blank of ["", "   ", "\n\n\t", "\u0000\u0001"]) expect(checkBriefText(blank)).toEqual({ ok: false, error: BRIEF_TEXT_MESSAGES.empty });
    expect(checkBriefText(undefined)).toEqual({ ok: false, error: BRIEF_TEXT_MESSAGES.empty });
    expect(checkBriefText(null)).toEqual({ ok: false, error: BRIEF_TEXT_MESSAGES.empty });
    expect(checkBriefText("--- *** ---")).toEqual({ ok: false, error: BRIEF_TEXT_MESSAGES.noWords });
    expect(checkBriefText("a".repeat(BRIEF_TEXT_MAX_CHARS))).toEqual({ ok: true, value: "a".repeat(BRIEF_TEXT_MAX_CHARS) });
    expect(checkBriefText("a".repeat(BRIEF_TEXT_MAX_CHARS + 1))).toEqual({ ok: false, error: BRIEF_TEXT_MESSAGES.tooLong(BRIEF_TEXT_MAX_CHARS + 1) });
    expect(BRIEF_TEXT_MESSAGES.tooLong(20_001)).toBe("The brief text is too long (20,001 characters). The limit is 20,000 — upload it as a file instead.");
  });

  it("file names never repeat one already in the session", () => {
    expect(briefTextFileName([])).toBe("Typed brief.txt");
    expect(briefTextFileName(["brief.pdf", "typed brief.txt"])).toBe("Typed brief 2.txt");
    expect(briefTextFileName(["Typed brief.txt", "Typed brief 2.txt"])).toBe("Typed brief 3.txt");
  });
});

describe("brief text: saved, read and confirmed like an uploaded brief", () => {
  const LIMIT = 25 * 1024 * 1024;
  const T0 = new Date("2026-11-09T09:00:00Z");
  let db: Database;
  let close: () => Promise<void>;
  let dee: User;
  let acme: string;
  let session: QcSession;
  let fake: ReturnType<typeof createFakeBucket>;
  let tempRoot: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDatabase());
    dee = await insertTestUser(db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    acme = (await insertCompany(db, { name: "Acme", createdBy: dee.id })).id;
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "qc-brief-text-"));
  });
  afterAll(() => close());
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake = createFakeBucket();
    await db.query("delete from qc_sessions");
    session = await startSession(db, fake.bucket, { companyId: acme, userId: dee.id, contentType: "social_post" }, T0);
  });

  /** The page's file upload: prepare → browser PUT → confirm. */
  async function upload(kind: "information" | "content", name: string, bytes: Uint8Array, type = "") {
    const prepared = await prepareUpload(db, fake.bucket, session, { kind, name, size: bytes.length, type }, LIMIT, T0);
    if (!prepared.ok) throw new Error(prepared.error);
    fake.browserPut(prepared.uploadUrl, bytes);
    const confirmed = await confirmUpload(db, fake.bucket, session, prepared.fileId, LIMIT, T0);
    if (!confirmed.ok) throw new Error(confirmed.error);
    return confirmed.file;
  }
  /** The worker reading the brief (the mock AI proposes each file's first line). */
  async function readBrief() {
    const files = (await listFiles(db, session.id, "ready")).filter((f) => f.kind === "information");
    await insertRun(db, { sessionId: session.id, userId: dee.id, kind: "information", provider: "mock", fingerprint: filesFingerprint(files) }, T0);
    const claimed = (await claimNextRun(db, T0, "mock"))!;
    return processRun(
      { db, storage: fake.bucket, logoStorage: null, provider: new MockProvider(), preparer: new PassThroughPreparer(), tempRoot, now: () => T0, sleep: async () => {} },
      claimed
    );
  }
  /** Check Design, then what the QC engine is given. */
  async function checkDesign() {
    const ready = await markReady(db, session, await listRequirements(db, session.id), await listFiles(db, session.id, "ready"), T0);
    const company = (await findAccessibleCompany(db, { id: dee.id, role: dee.role }, acme))!;
    return { ready, input: await loadQcInput(db, company, session) };
  }

  it("text only: saved as a plain-text brief in the session's own folder, then read, confirmed and given to the QC engine", async () => {
    const saved = await saveBriefText(db, fake.bucket, session, "Summer Escape\r\nCall +971 4 123 4567\r\nVisit www.skybook.com  ", LIMIT, T0);
    expect(saved).toMatchObject({ ok: true, file: { kind: "information", file_name: "Typed brief.txt", mime_type: "text/plain", status: "ready" } });
    if (!saved.ok) return;
    // Stored exactly like an upload: a server-made path, the tidied text, the real size.
    expect(saved.file.storage_path).toMatch(new RegExp(`^${session.id}/[0-9a-f-]{36}\\.txt$`));
    const stored = new TextDecoder().decode(fake.files.get(saved.file.storage_path));
    expect(stored).toBe("Summer Escape\nCall +971 4 123 4567\nVisit www.skybook.com\n");
    expect(saved.file.file_size).toBe(new TextEncoder().encode(stored).length);

    expect(await readBrief()).toBe("done");
    const found = await listRequirements(db, session.id);
    expect(found.map((r) => [r.type, r.expected_value])).toEqual(
      expect.arrayContaining([
        ["phone", "+971 4 123 4567"],
        ["website", "www.skybook.com"],
        ["required_text", "Summer Escape"],
      ])
    );
    expect(found.every((r) => !r.confirmed && r.source_file_id === saved.file.id && r.notes === "Found in Typed brief.txt")).toBe(true);

    await upload("content", "post.png", PNG, "image/png");
    const { ready, input } = await checkDesign();
    expect(ready).toEqual({ ok: true });
    expect(input.requirements.map((r) => r.expectedValue)).toEqual(expect.arrayContaining(["+971 4 123 4567", "www.skybook.com", "Summer Escape"]));
  });

  it("file only: unchanged — an uploaded brief is read and its requirements reach the QC engine", async () => {
    await upload("information", "notes.txt", new TextEncoder().encode("Email sales@skybook.com"), "text/plain");
    expect(await readBrief()).toBe("done");
    await upload("content", "post.png", PNG, "image/png");
    const { ready, input } = await checkDesign();
    expect(ready).toEqual({ ok: true });
    expect(input.requirements.map((r) => r.expectedValue)).toContain("sales@skybook.com");
  });

  it("file and text together: both are read in one brief reading, each requirement linked to its own source", async () => {
    const file = await upload("information", "notes.txt", new TextEncoder().encode("Email sales@skybook.com"), "text/plain");
    const typed = await saveBriefText(db, fake.bucket, session, "Call +971 4 123 4567", LIMIT, T0);
    if (!typed.ok) throw new Error(typed.error);
    expect((await listFiles(db, session.id)).map((f) => f.file_name).sort()).toEqual(["Typed brief.txt", "notes.txt"]);

    expect(await readBrief()).toBe("done");
    const found = await listRequirements(db, session.id);
    expect(found.find((r) => r.expected_value === "sales@skybook.com")?.source_file_id).toBe(file.id);
    expect(found.find((r) => r.expected_value === "+971 4 123 4567")?.source_file_id).toBe(typed.file.id);

    await upload("content", "post.png", PNG, "image/png");
    const { input } = await checkDesign();
    expect(input.requirements.map((r) => r.expectedValue)).toEqual(expect.arrayContaining(["sales@skybook.com", "+971 4 123 4567"]));
  });

  it("a second typed brief gets its own name; removing one removes its stored file", async () => {
    const one = await saveBriefText(db, fake.bucket, session, "Headline: Sale", LIMIT, T0);
    const two = await saveBriefText(db, fake.bucket, session, "Price AED 99", LIMIT, T0);
    if (!one.ok || !two.ok) throw new Error("not saved");
    expect(two.file.file_name).toBe("Typed brief 2.txt");
    expect(await removeFile(db, fake.bucket, session, one.file.id, T0)).toEqual({ ok: true });
    expect([...fake.files.keys()]).toEqual([two.file.storage_path]);
  });

  it("empty or invalid text: refused with a clear message — nothing stored, no file record", async () => {
    for (const [text, error] of [
      ["", BRIEF_TEXT_MESSAGES.empty],
      ["   \n  ", BRIEF_TEXT_MESSAGES.empty],
      [42, BRIEF_TEXT_MESSAGES.empty],
      ["!!! ???", BRIEF_TEXT_MESSAGES.noWords],
      ["x".repeat(BRIEF_TEXT_MAX_CHARS + 5), BRIEF_TEXT_MESSAGES.tooLong(BRIEF_TEXT_MAX_CHARS + 5)],
    ] as const) {
      expect(await saveBriefText(db, fake.bucket, session, text, LIMIT, T0)).toEqual({ ok: false, error });
    }
    expect(await listFiles(db, session.id, "any")).toEqual([]);
    expect(fake.files.size).toBe(0);
    // With no brief, Check Design still asks for one.
    expect(readinessProblems([], [])).toContain(READINESS_MESSAGES.brief);
  });

  it("the brief area's file limit applies to typed briefs too", async () => {
    for (let i = 0; i < 10; i++) await saveBriefText(db, fake.bucket, session, `Line ${i}`, LIMIT, T0);
    expect(await saveBriefText(db, fake.bucket, session, "One more", LIMIT, T0)).toEqual({ ok: false, error: QC_FILE_MESSAGES.tooMany(10) });
    expect(fake.files.size).toBe(10);
  });

  it("Storage failing: a friendly error and nothing left behind", async () => {
    fake.bucket.upload = async () => {
      throw new Error("storage down");
    };
    expect(await saveBriefText(db, fake.bucket, session, "Headline: Sale", LIMIT, T0)).toEqual({ ok: false, error: SESSION_MESSAGES.storageDown });
    expect(await listFiles(db, session.id, "any")).toEqual([]);
  });

  it("removed with its session by the usual 24-hour clean-up", async () => {
    await saveBriefText(db, fake.bucket, session, "Headline: Sale", LIMIT, T0);
    expect(fake.files.size).toBe(1);
    await purgeExpiredSessions(db, fake.bucket, new Date(T0.getTime() + 25 * 3_600_000));
    expect(fake.files.size).toBe(0);
    expect(await db.query("select id from qc_sessions")).toEqual([]);
  });
});
