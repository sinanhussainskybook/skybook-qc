import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import { insertCompany } from "@/lib/db/companies";
import {
  countFiles,
  deleteFileRow,
  deleteRequirement,
  findCurrentSession,
  findOwnedSession,
  insertPendingFile,
  insertRequirement,
  insertSession,
  listExpiredSessionIds,
  listFiles,
  listRequirements,
  markFileReady,
  setRequirementConfirmed,
  touchSession,
  updateRequirement,
} from "@/lib/db/qc-sessions";

const T0 = new Date("2026-09-30T08:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const requirement = (over = {}) => ({
  type: "offer",
  label: null,
  expected_value: "20% off",
  notes: null,
  mandatory: true,
  confirmed: false,
  ...over,
});

describe("QC sessions in the database (D11)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let dee: { id: string };
  let sam: { id: string };
  let acme: string;
  let globex: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDatabase());
    dee = await insertTestUser(db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    sam = await insertTestUser(db, { name: "Sam", email: "sam@skybook.com", role: "designer" });
    acme = (await insertCompany(db, { name: "Acme", createdBy: dee.id })).id;
    globex = (await insertCompany(db, { name: "Globex", createdBy: dee.id })).id;
  });
  afterAll(() => close());

  describe("sessions", () => {
    it("creates a draft session for a designer and company, lasting 24 hours", async () => {
      const session = await insertSession(db, { companyId: acme, userId: dee.id, contentType: "design_poster" }, T0);
      expect(session).toMatchObject({ company_id: acme, user_id: dee.id, content_type: "design_poster", status: "draft" });
      expect(session!.expires_at.getTime()).toBe(hours(24).getTime());
    });

    it("keeps ONE current session per designer per company — no history", async () => {
      expect(await insertSession(db, { companyId: acme, userId: dee.id, contentType: "reel_short" }, T0)).toBeNull();
      const rows = await db.query("select id from qc_sessions where company_id = $1 and user_id = $2", [acme, dee.id]);
      expect(rows).toHaveLength(1);
      // Another company, or another designer, gets their own.
      expect(await insertSession(db, { companyId: globex, userId: dee.id, contentType: "social_post" }, T0)).not.toBeNull();
      expect(await insertSession(db, { companyId: acme, userId: sam.id, contentType: "youtube_video" }, T0)).not.toBeNull();
    });

    it("only the owner can open a session, and only before it expires", async () => {
      const mine = (await findCurrentSession(db, acme, dee.id, T0))!;
      expect(await findOwnedSession(db, mine.id, dee.id, hours(1))).not.toBeNull();
      expect(await findOwnedSession(db, mine.id, sam.id, hours(1))).toBeNull(); // another designer
      expect(await findOwnedSession(db, mine.id, dee.id, hours(24))).toBeNull(); // expired
      expect(await findCurrentSession(db, acme, dee.id, hours(25))).toBeNull();
    });

    it("every change restarts the 24-hour clock and returns the session to draft", async () => {
      const mine = (await findCurrentSession(db, acme, dee.id, T0))!;
      await touchSession(db, mine.id, hours(10), { status: "ready" });
      expect(await findOwnedSession(db, mine.id, dee.id, hours(30))).toMatchObject({ status: "ready" });
      await touchSession(db, mine.id, hours(12), { contentType: "reel_short" });
      const after = (await findOwnedSession(db, mine.id, dee.id, hours(12)))!;
      expect(after).toMatchObject({ status: "draft", content_type: "reel_short" });
      expect(after.expires_at.getTime()).toBe(hours(36).getTime());
    });

    it("finds expired sessions for clean-up", async () => {
      const ids = await listExpiredSessionIds(db, hours(100));
      expect(ids.length).toBeGreaterThanOrEqual(3);
      expect(await listExpiredSessionIds(db, hours(1))).toEqual([]);
    });

    it("the database refuses unknown content types and statuses", async () => {
      await expect(
        db.query("insert into qc_sessions (company_id, user_id, content_type) values ($1, $2, 'podcast')", [globex, sam.id])
      ).rejects.toThrow();
      await expect(db.query("update qc_sessions set status = 'pass'")).rejects.toThrow();
    });
  });

  describe("requirements", () => {
    it("adds, edits, confirms and deletes — only within their own session", async () => {
      const mine = (await findCurrentSession(db, acme, dee.id, T0))!;
      const sams = (await findCurrentSession(db, acme, sam.id, T0))!;

      const a = await insertRequirement(db, mine.id, requirement(), T0);
      // Added a moment later — requirements are listed in the order they were added.
      const b = await insertRequirement(db, mine.id, requirement({ type: "phone", expected_value: "+971 4 123 4567", mandatory: false }), hours(0.01));
      expect((await listRequirements(db, mine.id)).map((r) => r.expected_value)).toEqual(["20% off", "+971 4 123 4567"]);
      expect((await listRequirements(db, mine.id))[0]).toMatchObject({ source: "manual", confirmed: false, mandatory: true });

      expect(await updateRequirement(db, mine.id, a, requirement({ expected_value: "25% off", confirmed: true }), T0)).toBe(true);
      expect(await setRequirementConfirmed(db, mine.id, b, true, T0)).toBe(true);
      expect((await listRequirements(db, mine.id)).map((r) => [r.expected_value, r.confirmed])).toEqual([
        ["25% off", true],
        ["+971 4 123 4567", true],
      ]);

      // Through another session: nothing happens.
      expect(await updateRequirement(db, sams.id, a, requirement({ expected_value: "hijacked" }), T0)).toBe(false);
      expect(await setRequirementConfirmed(db, sams.id, a, false, T0)).toBe(false);
      expect(await deleteRequirement(db, sams.id, a)).toBe(false);
      expect((await listRequirements(db, mine.id))[0].expected_value).toBe("25% off");

      expect(await deleteRequirement(db, mine.id, b)).toBe(true);
      expect(await listRequirements(db, mine.id)).toHaveLength(1);
    });

    it("accepts new type keys without a migration, but only safe ones", async () => {
      const mine = (await findCurrentSession(db, acme, dee.id, T0))!;
      await expect(insertRequirement(db, mine.id, requirement({ type: "launch_venue" }), T0)).resolves.toBeTruthy();
      await expect(insertRequirement(db, mine.id, requirement({ type: "Drop Table" }), T0)).rejects.toThrow();
      await expect(insertRequirement(db, mine.id, requirement({ expected_value: "" }), T0)).rejects.toThrow();
    });
  });

  describe("file records", () => {
    const pending = (sessionId: string, over = {}) => {
      const id = randomUUID();
      return {
        id,
        kind: "content" as const,
        fileName: "poster.png",
        storagePath: `${sessionId}/${id}.png`,
        mimeType: "image/png",
        fileSize: 1234,
        ...over,
      };
    };

    it("stores metadata only; a file becomes usable once checked", async () => {
      const mine = (await findCurrentSession(db, acme, dee.id, T0))!;
      const file = pending(mine.id);
      await insertPendingFile(db, mine.id, file, T0);
      expect(await listFiles(db, mine.id)).toEqual([]); // pending isn't shown
      expect(await countFiles(db, mine.id, "content")).toBe(1); // but counts toward the limit
      expect(await markFileReady(db, mine.id, file.id, 2000, T0)).toBe(true);
      expect(await listFiles(db, mine.id)).toMatchObject([{ id: file.id, file_size: 2000, status: "ready" }]);
    });

    it("the path must be inside its own session's folder, with a safe name", async () => {
      const mine = (await findCurrentSession(db, acme, dee.id, T0))!;
      const sams = (await findCurrentSession(db, acme, sam.id, T0))!;
      await expect(insertPendingFile(db, mine.id, pending(sams.id), T0)).rejects.toThrow(); // Sam's folder
      await expect(insertPendingFile(db, mine.id, { ...pending(mine.id), storagePath: `${mine.id}/../x.png` }, T0)).rejects.toThrow();
      await expect(insertPendingFile(db, mine.id, { ...pending(mine.id), storagePath: `${mine.id}/${randomUUID()}.exe` }, T0)).rejects.toThrow();
      await expect(insertPendingFile(db, mine.id, pending(mine.id, { mimeType: "text/html" }), T0)).rejects.toThrow();
      await expect(insertPendingFile(db, mine.id, pending(mine.id, { fileSize: 60 * 1024 * 1024 }), T0)).rejects.toThrow();
    });

    it("can't be removed through another session", async () => {
      const mine = (await findCurrentSession(db, acme, dee.id, T0))!;
      const sams = (await findCurrentSession(db, acme, sam.id, T0))!;
      const [file] = await listFiles(db, mine.id);
      expect(await deleteFileRow(db, sams.id, file.id)).toBeNull();
      expect(await deleteFileRow(db, mine.id, file.id)).toBe(file.storage_path);
    });
  });

  it("deleting a session removes its requirements and file records; deleting a company removes its sessions", async () => {
    const mine = (await findCurrentSession(db, acme, dee.id, T0))!;
    const file = { id: randomUUID(), kind: "information" as const, fileName: "brief.pdf", mimeType: "application/pdf", fileSize: 10 };
    await insertPendingFile(db, mine.id, { ...file, storagePath: `${mine.id}/${file.id}.pdf` }, T0);
    await db.query("delete from qc_sessions where id = $1", [mine.id]);
    expect(await db.query("select 1 from qc_requirements where session_id = $1", [mine.id])).toEqual([]);
    expect(await db.query("select 1 from qc_files where session_id = $1", [mine.id])).toEqual([]);

    await db.query("delete from companies where id = $1", [globex]);
    expect(await db.query("select 1 from qc_sessions where company_id = $1", [globex])).toEqual([]);
  });
});
