import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeBucket } from "../../../test/fake-storage";
import { EXE, JPEG, MP4, PDF, PNG } from "../../../test/logo-files";
import type { Database } from "@/lib/db/database";
import { insertCompany, findAccessibleCompany } from "@/lib/db/companies";
import {
  findCurrentSession,
  insertRequirement,
  listFiles,
  listRequirements,
  NO_PLATFORM,
  setSessionPlatform,
  type QcSession,
} from "@/lib/db/qc-sessions";
import {
  changeContentType,
  confirmUpload,
  markReady,
  prepareUpload,
  purgeExpiredSessions,
  readinessProblems,
  removeFile,
  removeSessionCompletely,
  startSession,
  READINESS_MESSAGES,
} from "@/lib/qc/session";
import { loadQcInput, missingCompanyInformation } from "@/lib/qc/qc-input";

const LIMIT = 25 * 1024 * 1024;
const T0 = new Date("2026-09-30T08:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);

describe("QC session rules (Storage faked)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let dee: { id: string };
  let acme: string;
  let fake: ReturnType<typeof createFakeBucket>;
  let session: QcSession;

  beforeAll(async () => {
    ({ db, close } = await createTestDatabase());
    dee = await insertTestUser(db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    acme = (await insertCompany(db, { name: "Acme", createdBy: dee.id })).id;
  });
  afterAll(() => close());
  beforeEach(async () => {
    fake = createFakeBucket();
    await db.query("delete from qc_sessions");
    session = await startSession(db, fake.bucket, { companyId: acme, userId: dee.id, contentType: "design_poster" }, T0);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /** The whole upload as the page does it: prepare → browser PUT → confirm. */
  async function upload(kind: "information" | "content", name: string, bytes: Uint8Array, type = "", claimedSize = bytes.length) {
    const prepared = await prepareUpload(db, fake.bucket, session, { kind, name, size: claimedSize, type }, LIMIT, T0);
    if (!prepared.ok) return prepared;
    fake.browserPut(prepared.uploadUrl, bytes);
    return confirmUpload(db, fake.bucket, session, prepared.fileId, LIMIT, T0);
  }

  describe("starting", () => {
    it("resumes the current session instead of creating a second one", async () => {
      const again = await startSession(db, fake.bucket, { companyId: acme, userId: dee.id, contentType: "reel_short" }, hours(1));
      expect(again.id).toBe(session.id);
      expect(again.content_type).toBe("design_poster");
    });

    it("starts fresh once the old one has expired — and deletes the old one's files", async () => {
      await upload("content", "poster.png", PNG);
      const fresh = await startSession(db, fake.bucket, { companyId: acme, userId: dee.id, contentType: "reel_short" }, hours(30));
      expect(fresh.id).not.toBe(session.id);
      expect(fresh.content_type).toBe("reel_short");
      expect(fake.files.size).toBe(0);
    });
  });

  describe("uploads", () => {
    it("uploads information and content into the session's own folder", async () => {
      expect(await upload("information", "brief.pdf", PDF, "application/pdf")).toMatchObject({ ok: true });
      expect(await upload("content", "poster.png", PNG, "image/png")).toMatchObject({ ok: true });
      const files = await listFiles(db, session.id);
      // Same timestamp in this test, so compare without assuming an order.
      expect(files.map((f) => [f.kind, f.file_name, f.mime_type]).sort()).toEqual([
        ["content", "poster.png", "image/png"],
        ["information", "brief.pdf", "application/pdf"],
      ]);
      for (const f of files) expect(f.storage_path).toMatch(new RegExp(`^${session.id}/[0-9a-f-]{36}\\.(pdf|png)$`));
      expect([...fake.files.keys()].sort()).toEqual(files.map((f) => f.storage_path).sort());
    });

    it("gives the same file name to two uploads safely (different storage IDs)", async () => {
      await upload("content", "final.png", PNG);
      await upload("content", "final.png", PNG);
      const files = await listFiles(db, session.id);
      expect(files).toHaveLength(2);
      expect(files[0].storage_path).not.toBe(files[1].storage_path);
    });

    it("rejects a disguised file AFTER upload and deletes it", async () => {
      expect(await upload("content", "poster.png", EXE, "image/png")).toEqual({
        ok: false,
        error: expect.stringMatching(/doesn't match/),
      });
      expect(await listFiles(db, session.id, "any")).toEqual([]);
      expect(fake.files.size).toBe(0);
    });

    it("uses the real size in Storage, not the size the browser claimed", async () => {
      const big = new Uint8Array(LIMIT + 10);
      big.set(PNG);
      expect(await upload("content", "poster.png", big, "image/png", 1000)).toMatchObject({ ok: false, error: /too large/ });
      expect(fake.files.size).toBe(0);
    });

    it("refuses content that doesn't fit the content type before any upload link is made", async () => {
      expect(await upload("content", "clip.mp4", MP4, "video/mp4")).toMatchObject({ ok: false });
      expect(fake.calls.filter((c) => c.startsWith("upload-link"))).toEqual([]);
    });

    it("limits files per area (one video for Reels)", async () => {
      await changeContentType(db, session, "reel_short", T0);
      session = (await findCurrentSession(db, acme, dee.id, T0))!;
      expect(await upload("content", "reel.mp4", MP4, "video/mp4")).toMatchObject({ ok: true });
      expect(await upload("content", "reel2.mp4", MP4, "video/mp4")).toMatchObject({ ok: false, error: /up to 1 file/ });
    });

    it("an upload that never arrived is refused and cleaned up", async () => {
      const prepared = await prepareUpload(db, fake.bucket, session, { kind: "content", name: "a.png", size: 10, type: "" }, LIMIT, T0);
      if (!prepared.ok) throw new Error(prepared.error);
      expect(await confirmUpload(db, fake.bucket, session, prepared.fileId, LIMIT, T0)).toMatchObject({ ok: false });
      expect(await listFiles(db, session.id, "any")).toEqual([]);
    });

    it("unfinished uploads are cleared after an hour, freeing their place", async () => {
      await prepareUpload(db, fake.bucket, session, { kind: "information", name: "a.pdf", size: 10, type: "" }, LIMIT, T0);
      expect(await listFiles(db, session.id, "any")).toHaveLength(1);
      await prepareUpload(db, fake.bucket, session, { kind: "information", name: "b.pdf", size: 10, type: "" }, LIMIT, hours(2));
      expect((await listFiles(db, session.id, "any")).map((f) => f.file_name)).toEqual(["b.pdf"]);
    });

    it("Storage failing to make a link: friendly error, nothing left behind", async () => {
      fake.failing.sign = true;
      expect(await upload("content", "poster.png", PNG)).toEqual({ ok: false, error: expect.stringMatching(/can't be uploaded right now/) });
      expect(await listFiles(db, session.id, "any")).toEqual([]);
    });

    it("removes a file from the session and from Storage", async () => {
      await upload("content", "poster.png", PNG);
      const [file] = await listFiles(db, session.id);
      expect(await removeFile(db, fake.bucket, session, file.id, T0)).toEqual({ ok: true });
      expect(fake.files.size).toBe(0);
      expect(await removeFile(db, fake.bucket, session, file.id, T0)).toMatchObject({ ok: false });
    });
  });

  describe("content type", () => {
    it("switches freely while no content is uploaded", async () => {
      expect(await changeContentType(db, session, "youtube_video", T0)).toEqual({ ok: true });
    });

    it("refuses a switch the uploaded content doesn't fit", async () => {
      await upload("content", "poster.png", PNG);
      expect(await changeContentType(db, session, "reel_short", T0)).toMatchObject({ ok: false, error: /Remove the uploaded content first/ });
      expect(await changeContentType(db, session, "social_post", T0)).toEqual({ ok: true }); // images fit a post too
    });
  });

  describe("ready", () => {
    it("needs a platform, uploaded content and at least one requirement; Confirm & Run QC confirms them all", async () => {
      // No requirements: blocked — a PASS with nothing to check against would mislead.
      expect(readinessProblems([], [])).toEqual([READINESS_MESSAGES.content, READINESS_MESSAGES.requirements]);
      expect(READINESS_MESSAGES.requirements).toBe("Add or confirm the client's requirements before running QC.");

      await insertRequirement(db, session.id, { type: "offer", label: null, expected_value: "20% off", notes: null, mandatory: true, confirmed: false }, T0);
      await insertRequirement(db, session.id, { type: "price", label: null, expected_value: "AED 99", notes: null, mandatory: true, confirmed: false }, T0);
      const requirements = await listRequirements(db, session.id);
      // Unconfirmed is fine here: the button confirms the list.
      expect(readinessProblems(requirements, [])).toEqual([READINESS_MESSAGES.content]);
      // While the brief is still being read, wait for it.
      expect(readinessProblems(requirements, [], undefined, { briefReading: true })).toEqual([READINESS_MESSAGES.content, READINESS_MESSAGES.briefReading]);

      await upload("content", "poster.jpg", JPEG);
      const files = await listFiles(db, session.id);
      expect(await markReady(db, session, requirements, files, T0)).toEqual({ ok: false, problems: [READINESS_MESSAGES.platform] });
      expect((await listRequirements(db, session.id)).some((r) => r.confirmed)).toBe(false); // nothing changed

      await setSessionPlatform(db, session.id, { ...NO_PLATFORM, platform: "instagram", placement: "feed_image" }, T0);
      const withPlatform = (await findCurrentSession(db, acme, dee.id, T0))!;
      expect(await markReady(db, withPlatform, requirements, files, T0)).toEqual({ ok: true });
      expect((await findCurrentSession(db, acme, dee.id, T0))!.status).toBe("ready");
      expect((await listRequirements(db, session.id)).every((r) => r.confirmed)).toBe(true);
    });

    it("an exact size in the brief (Dimensions 1080 × 1080) stands in for the platform choice", async () => {
      await upload("content", "poster.jpg", JPEG);
      const files = await listFiles(db, session.id);
      await insertRequirement(db, session.id, { type: "dimensions", label: null, expected_value: "Square, roughly", notes: null, mandatory: true, confirmed: false }, T0);
      expect(readinessProblems(await listRequirements(db, session.id), files, session)).toEqual([READINESS_MESSAGES.platform]);
      await insertRequirement(db, session.id, { type: "dimensions", label: null, expected_value: "1080 × 1080 px", notes: null, mandatory: true, confirmed: false }, T0);
      const requirements = await listRequirements(db, session.id);
      expect(readinessProblems(requirements, files, session)).toEqual([]);
      expect(await markReady(db, session, requirements, files, T0)).toEqual({ ok: true });
    });
  });

  describe("clean-up", () => {
    it("Start over deletes the session, its requirements, records and every file (unfinished uploads too)", async () => {
      await upload("content", "poster.png", PNG);
      await prepareUpload(db, fake.bucket, session, { kind: "information", name: "half.pdf", size: 10, type: "" }, LIMIT, T0);
      fake.files.set(`${session.id}/orphan.pdf`, PDF); // a partial upload with no record
      expect(await removeSessionCompletely(db, fake.bucket, session.id)).toBe(true);
      expect(fake.files.size).toBe(0);
      expect(await db.query("select 1 from qc_sessions where id = $1", [session.id])).toEqual([]);
    });

    it("expired sessions are purged; running ones are left alone", async () => {
      await upload("content", "poster.png", PNG);
      expect(await purgeExpiredSessions(db, fake.bucket, hours(1))).toBe(0);
      expect(await purgeExpiredSessions(db, fake.bucket, hours(25))).toBe(1);
      expect(fake.files.size).toBe(0);
      expect(await db.query("select 1 from qc_sessions")).toEqual([]);
    });

    it("if Storage is down, the session is kept so nothing is left behind unreferenced", async () => {
      await upload("content", "poster.png", PNG);
      fake.failing.list = true;
      expect(await purgeExpiredSessions(db, fake.bucket, hours(25))).toBe(0);
      expect(await db.query("select 1 from qc_sessions")).toHaveLength(1);
      fake.failing.list = false;
      expect(await purgeExpiredSessions(db, fake.bucket, hours(25))).toBe(1);
    });
  });

  describe("the QC engine's input", () => {
    it("combines the saved company configuration with this session — confirmed requirements only", async () => {
      await upload("information", "brief.pdf", PDF);
      await upload("content", "poster.png", PNG);
      await insertRequirement(db, session.id, { type: "offer", label: "Summer", expected_value: "20% off", notes: null, mandatory: true, confirmed: true }, T0);
      await insertRequirement(db, session.id, { type: "cta", label: null, expected_value: "Book now", notes: null, mandatory: false, confirmed: false }, T0);
      const company = (await findAccessibleCompany(db, { id: dee.id, role: "designer" }, acme))!;

      const input = await loadQcInput(db, company, session);
      expect(input.company.company.name).toBe("Acme");
      expect(input.session).toEqual({
        id: session.id,
        contentType: "design_poster",
        status: "draft",
        platform: null,
        placement: null,
        custom: null,
      });
      expect(input.requirements).toEqual([
        { type: "offer", label: "Summer", expectedValue: "20% off", notes: null, mandatory: true, source: "manual" },
      ]);
      expect(input.unconfirmedRequirementCount).toBe(1);
      expect(input.informationFiles.map((f) => f.fileName)).toEqual(["brief.pdf"]);
      expect(input.contentFiles.map((f) => f.fileName)).toEqual(["poster.png"]);
      expect(missingCompanyInformation(input.company)).toEqual(["contact details", "logo", "brand colours", "fonts", "Golden Rules"]);
    });
  });
});
