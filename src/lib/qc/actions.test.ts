import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeBucket } from "../../../test/fake-storage";
import { PNG } from "../../../test/logo-files";
import type { Database } from "@/lib/db/database";
import type { User } from "@/lib/db/users";
import type { BucketClient } from "@/lib/storage/storage-api";

/**
 * The Phase 4 server actions with a real (in-memory) PostgreSQL and a fake
 * Storage. Only sign-in and Next.js navigation are stand-ins.
 */

const state = vi.hoisted(() => ({
  db: null as unknown as Database,
  user: null as User | null,
  storage: null as BucketClient | null,
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/auth/current-user", () => ({
  requireUser: async () => {
    if (!state.user) throw new Error("NEXT_REDIRECT /login");
    return state.user;
  },
}));
vi.mock("@/lib/storage/qc-storage", () => ({ getQcStorage: () => state.storage }));

const actions = await import("@/lib/qc/actions");
const { insertCompany, addCompanyMember } = await import("@/lib/db/companies");
const { findCurrentSession, listRequirements, listFiles, deleteSessionRow } = await import("@/lib/db/qc-sessions");
const { purgeExpiredBatch, removeSessionCompletely } = await import("@/lib/qc/session");

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

describe("Phase 4 actions and authorization", () => {
  let close: () => Promise<void>;
  let dee: User;
  let sam: User;
  let ada: User;
  let acme: string; // Dee and Sam are members
  let globex: string; // only Sam
  let fake: ReturnType<typeof createFakeBucket>;

  const sessionOf = async (user: User, companyId: string) =>
    (await findCurrentSession(state.db, companyId, user.id, new Date()))!;

  beforeAll(async () => {
    const test = await createTestDatabase();
    state.db = test.db;
    close = test.close;
    dee = await insertTestUser(test.db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    sam = await insertTestUser(test.db, { name: "Sam", email: "sam@skybook.com", role: "designer" });
    ada = await insertTestUser(test.db, { name: "Ada", email: "ada@skybook.com", role: "admin" });
    acme = (await insertCompany(test.db, { name: "Acme", createdBy: dee.id })).id;
    await addCompanyMember(test.db, acme, sam.id);
    globex = (await insertCompany(test.db, { name: "Globex", createdBy: sam.id })).id;
  });
  afterAll(() => close());
  beforeEach(async () => {
    fake = createFakeBucket();
    state.storage = fake.bucket;
    state.user = dee;
    await state.db.query("delete from qc_sessions");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("starts a session for each offered (static design) content type", async () => {
    for (const contentType of ["design_poster", "social_post"]) {
      await state.db.query("delete from qc_sessions");
      expect(await actions.startSessionAction({}, form({ companyId: acme, contentType }))).toEqual({ ok: true });
      expect((await sessionOf(dee, acme)).content_type).toBe(contentType);
    }
    expect(await actions.startSessionAction({}, form({ companyId: acme, contentType: "podcast" }))).toMatchObject({ error: /Choose/ });
  });

  it("video content types are hidden: a forged request can't start or switch to one", async () => {
    await state.db.query("delete from qc_sessions");
    for (const contentType of ["reel_short", "youtube_video"]) {
      expect(await actions.startSessionAction({}, form({ companyId: acme, contentType }))).toEqual({ error: "Choose what you're checking." });
    }
    expect(await state.db.query("select id from qc_sessions")).toEqual([]);
    await actions.startSessionAction({}, form({ companyId: acme, contentType: "design_poster" }));
    const { id: sessionId } = await sessionOf(dee, acme);
    expect(await actions.changeContentTypeAction({}, form({ sessionId, contentType: "reel_short" }))).toEqual({ error: "Choose what you're checking." });
    expect((await sessionOf(dee, acme)).content_type).toBe("design_poster");
  });

  it("adds, edits, confirms and deletes requirements — several at once", async () => {
    await actions.startSessionAction({}, form({ companyId: acme, contentType: "design_poster" }));
    const { id: sessionId } = await sessionOf(dee, acme);

    expect(await actions.saveRequirementAction({}, form({ sessionId, type: "offer", expected_value: "20% off", mandatory: "on" }))).toEqual({ ok: true });
    expect(await actions.saveRequirementAction({}, form({ sessionId, type: "phone", expected_value: "+971 4 123 4567" }))).toEqual({ ok: true });
    let list = await listRequirements(state.db, sessionId);
    expect(list.map((r) => [r.type, r.mandatory, r.confirmed])).toEqual([["offer", true, false], ["phone", false, false]]);

    expect(
      await actions.saveRequirementAction({}, form({ sessionId, requirementId: list[0].id, type: "offer", expected_value: "25% off", mandatory: "on", confirmed: "on" }))
    ).toEqual({ ok: true });
    expect(await actions.setRequirementConfirmedAction({}, form({ sessionId, requirementId: list[1].id, confirmed: "true" }))).toEqual({ ok: true });
    list = await listRequirements(state.db, sessionId);
    expect(list.map((r) => [r.expected_value, r.confirmed])).toEqual([["25% off", true], ["+971 4 123 4567", true]]);

    expect(await actions.deleteRequirementAction({}, form({ sessionId, requirementId: list[1].id }))).toEqual({ ok: true });
    expect(await listRequirements(state.db, sessionId)).toHaveLength(1);

    expect(await actions.saveRequirementAction({}, form({ sessionId, type: "", expected_value: "" }))).toEqual({
      errors: { type: expect.any(String), expected_value: expect.any(String) },
    });
  });

  it("uploads through a server-chosen path and marks the session ready", async () => {
    await actions.startSessionAction({}, form({ companyId: acme, contentType: "design_poster" }));
    const { id: sessionId } = await sessionOf(dee, acme);

    const prepared = await actions.prepareUploadAction({ sessionId, kind: "content", name: "../../poster.png", size: PNG.length, type: "image/png" });
    if (!prepared.ok) throw new Error(prepared.error);
    const path = fake.browserPut(prepared.uploadUrl, PNG);
    expect(path).toMatch(new RegExp(`^${sessionId}/[0-9a-f-]{36}\\.png$`));
    expect(await actions.confirmUploadAction({ sessionId, fileId: prepared.fileId })).toEqual({ ok: true });
    expect((await listFiles(state.db, sessionId)).map((f) => f.file_name)).toEqual(["poster.png"]);

    expect(await actions.markReadyAction({}, form({ sessionId }))).toMatchObject({
      error: expect.stringContaining("Upload the client brief"),
    });
    expect(await actions.saveRequirementAction({}, form({ sessionId, type: "offer", expected_value: "20% off", mandatory: "on" }))).toEqual({ ok: true });
    expect(
      await actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "feed_image" }))
    ).toMatchObject({ ok: true });
    expect(await actions.markReadyAction({}, form({ sessionId }))).toMatchObject({ ok: true });
    expect((await sessionOf(dee, acme)).status).toBe("ready");
  });

  describe("Start a QC check: a completed check is never reopened; an unfinished one is", () => {
    const upload = async (sessionId: string) => {
      const prepared = await actions.prepareUploadAction({ sessionId, kind: "content", name: "poster.png", size: PNG.length, type: "image/png" });
      if (!prepared.ok) throw new Error(prepared.error);
      const path = fake.browserPut(prepared.uploadUrl, PNG);
      expect(await actions.confirmUploadAction({ sessionId, fileId: prepared.fileId })).toEqual({ ok: true });
      return path;
    };
    const start = () => actions.startSessionAction({}, form({ companyId: acme, contentType: "design_poster" }));
    const run = (sessionId: string, kind: "content" | "information", status: string) =>
      state.db.query(
        "insert into qc_analysis_runs (session_id, requested_by, kind, provider, status, files_fingerprint) values ($1, $2, $3, 'mock', $4, 'x')",
        [sessionId, dee.id, kind, status]
      );
    const runCount = async (sessionId: string) =>
      Number((await state.db.query<{ n: number }>("select count(*)::int as n from qc_analysis_runs where session_id = $1", [sessionId]))[0].n);

    it("unfinished (files uploaded, nothing checked yet) → opened again unchanged, files kept", async () => {
      await start();
      const current = await sessionOf(dee, acme);
      const file = await upload(current.id);
      await actions.saveRequirementAction({}, form({ sessionId: current.id, type: "offer", expected_value: "20% off" }));
      expect(await start()).toEqual({ ok: true });
      expect((await sessionOf(dee, acme)).id).toBe(current.id);
      expect(fake.files.has(file)).toBe(true);
      expect(await listRequirements(state.db, current.id)).toHaveLength(1);
    });

    it("a failed or still-running design check, or only the brief read, is NOT complete → opened again", async () => {
      await start();
      const current = await sessionOf(dee, acme);
      for (const [kind, status] of [["content", "failed"], ["content", "processing"], ["information", "done"]] as const) {
        await state.db.query("delete from qc_analysis_runs");
        await run(current.id, kind, status);
        expect(await start(), `${kind} ${status}`).toEqual({ ok: true });
        expect((await sessionOf(dee, acme)).id).toBe(current.id);
      }
    });

    it("completed (design check finished) → the server asks to confirm and changes nothing — even when called directly", async () => {
      await start();
      const done = await sessionOf(dee, acme);
      const file = await upload(done.id);
      await run(done.id, "content", "done");
      for (let i = 0; i < 2; i++) {
        expect(await start()).toEqual({ confirmNewCheck: { sessionId: done.id } });
      }
      expect((await sessionOf(dee, acme)).id).toBe(done.id);
      expect(fake.files.has(file)).toBe(true);
      expect(await runCount(done.id)).toBe(1);
    });

    it("confirmed → the completed check's files and records are removed and a fresh, empty check starts (no old result)", async () => {
      await start();
      const done = await sessionOf(dee, acme);
      const file = await upload(done.id);
      await actions.saveRequirementAction({}, form({ sessionId: done.id, type: "offer", expected_value: "20% off" }));
      await run(done.id, "content", "done");
      expect(await actions.startNewCheckAction({}, form({ companyId: acme, sessionId: done.id, contentType: "design_poster" }))).toEqual({ ok: true });
      const fresh = await sessionOf(dee, acme);
      expect(fresh.id).not.toBe(done.id);
      expect(fresh.status).toBe("draft");
      expect(await listFiles(state.db, fresh.id, "any")).toEqual([]);
      expect(await listRequirements(state.db, fresh.id)).toEqual([]);
      expect(await runCount(fresh.id)).toBe(0); // no analysis → no result shown
      expect(await runCount(done.id)).toBe(0); // the old runs went with the old check
      expect(fake.files.has(file)).toBe(false);
      // The fresh check is unfinished, so Start opens it without asking.
      expect(await start()).toEqual({ ok: true });
      expect((await sessionOf(dee, acme)).id).toBe(fresh.id);
    });

    it("if the files can't be removed, the completed check is kept whole and is still not reopened", async () => {
      await start();
      const done = await sessionOf(dee, acme);
      const file = await upload(done.id);
      await run(done.id, "content", "done");
      fake.failing.list = true;
      expect(await actions.startNewCheckAction({}, form({ companyId: acme, sessionId: done.id, contentType: "design_poster" }))).toEqual({
        error: "The session couldn't be cleared right now. Please try again in a moment.",
      });
      fake.failing.list = false;
      expect((await sessionOf(dee, acme)).id).toBe(done.id);
      expect(fake.files.has(file)).toBe(true);
      expect(await runCount(done.id)).toBe(1);
      expect(await start()).toEqual({ confirmNewCheck: { sessionId: done.id } });
    });

    it("expired (24 hours after the last change) → never reopened: a fresh check starts and the old files are removed", async () => {
      await start();
      const old = await sessionOf(dee, acme);
      const file = await upload(old.id);
      await state.db.query("update qc_sessions set expires_at = now() - interval '1 minute' where id = $1", [old.id]);
      expect(await start()).toEqual({ ok: true });
      const fresh = await sessionOf(dee, acme);
      expect(fresh.id).not.toBe(old.id);
      expect(await listFiles(state.db, fresh.id, "any")).toEqual([]);
      expect(fake.files.has(file)).toBe(false);
    });

    it("Start never touches company settings", async () => {
      const before = await state.db.query("select * from companies where id = $1", [acme]);
      await start();
      const done = await sessionOf(dee, acme);
      await run(done.id, "content", "done");
      await actions.startNewCheckAction({}, form({ companyId: acme, sessionId: done.id, contentType: "design_poster" }));
      expect(await state.db.query("select * from companies where id = $1", [acme])).toEqual(before);
    });
  });

  describe("Start a new check (company page): Start over for THIS company's check, then a fresh one", () => {
    const upload = async (sessionId: string) => {
      const prepared = await actions.prepareUploadAction({ sessionId, kind: "content", name: "poster.png", size: PNG.length, type: "image/png" });
      if (!prepared.ok) throw new Error(prepared.error);
      const path = fake.browserPut(prepared.uploadUrl, PNG);
      expect(await actions.confirmUploadAction({ sessionId, fileId: prepared.fileId })).toEqual({ ok: true });
      return path;
    };
    const start = (companyId: string) => actions.startSessionAction({}, form({ companyId, contentType: "design_poster" }));
    const newCheck = (companyId: string, sessionId: string) => actions.startNewCheckAction({}, form({ companyId, sessionId, contentType: "design_poster" }));
    const sessionIds = async () => (await state.db.query<{ id: string }>("select id from qc_sessions order by id")).map((r) => r.id);

    it("removes only this company's current check (its files, then its records) and starts a fresh, empty one", async () => {
      state.user = ada; // an admin can open both companies
      await start(acme);
      await start(globex);
      const old = await sessionOf(ada, acme);
      const keptOther = await sessionOf(ada, globex);
      const oldFile = await upload(old.id);
      const keptFile = await upload(keptOther.id);
      await actions.saveRequirementAction({}, form({ sessionId: old.id, type: "offer", expected_value: "20% off" }));
      state.user = sam; // another designer's check for the same company
      await start(acme);
      const samsCheck = await sessionOf(sam, acme);

      state.user = ada;
      expect(await newCheck(acme, old.id)).toEqual({ ok: true });

      const fresh = await sessionOf(ada, acme);
      expect(fresh.id).not.toBe(old.id);
      expect(fresh.status).toBe("draft");
      expect(await listFiles(state.db, fresh.id, "any")).toEqual([]);
      expect(await listRequirements(state.db, fresh.id)).toEqual([]);
      expect(fake.files.has(oldFile)).toBe(false);
      // Untouched: the same designer's check for another company, and another designer's check for this one.
      expect(fake.files.has(keptFile)).toBe(true);
      expect((await sessionOf(ada, globex)).id).toBe(keptOther.id);
      expect((await sessionOf(sam, acme)).id).toBe(samsCheck.id);
      expect(await sessionIds()).not.toContain(old.id);
    });

    it("refused, nothing changed: a check of another company, or another designer's check", async () => {
      state.user = ada;
      await start(globex);
      const globexCheck = await sessionOf(ada, globex);
      expect(await newCheck(acme, globexCheck.id)).toEqual({ error: "This QC session isn't available any more. Reload the page." });
      state.user = sam;
      await start(acme);
      const samsCheck = await sessionOf(sam, acme);
      state.user = dee;
      expect(await newCheck(acme, samsCheck.id)).toEqual({ error: "This QC session isn't available any more. Reload the page." });
      expect(await sessionIds()).toEqual([globexCheck.id, samsCheck.id].sort());
    });

    it("if Storage can't be reached, the check in progress is kept and nothing new is started", async () => {
      await start(acme);
      const current = await sessionOf(dee, acme);
      const file = await upload(current.id);
      fake.failing.list = true;
      expect(await newCheck(acme, current.id)).toEqual({ error: "The session couldn't be cleared right now. Please try again in a moment." });
      fake.failing.list = false;
      expect((await sessionOf(dee, acme)).id).toBe(current.id);
      expect(fake.files.has(file)).toBe(true);
    });
  });

  describe("authorization", () => {
    let deesSession: string;
    beforeEach(async () => {
      await actions.startSessionAction({}, form({ companyId: acme, contentType: "design_poster" }));
      deesSession = (await sessionOf(dee, acme)).id;
      await actions.saveRequirementAction({}, form({ sessionId: deesSession, type: "offer", expected_value: "20% off" }));
    });

    const everyAction = async (sessionId: unknown, requirementId = "00000000-0000-4000-8000-000000000000") => {
      const s = String(sessionId);
      return [
        await actions.changeContentTypeAction({}, form({ sessionId: s, contentType: "social_post" })),
        await actions.saveRequirementAction({}, form({ sessionId: s, type: "offer", expected_value: "hijacked" })),
        await actions.setRequirementConfirmedAction({}, form({ sessionId: s, requirementId, confirmed: "true" })),
        await actions.deleteRequirementAction({}, form({ sessionId: s, requirementId })),
        await actions.removeFileAction({}, form({ sessionId: s, fileId: requirementId })),
        await actions.markReadyAction({}, form({ sessionId: s })),
        await actions.setPlatformAction({}, form({ sessionId: s, platform: "instagram", placement: "feed_image" })),
        await actions.startOverAction({}, form({ sessionId: s })),
        await actions.prepareUploadAction({ sessionId: s, kind: "content", name: "x.png", size: 10, type: "" }),
        await actions.confirmUploadAction({ sessionId: s, fileId: requirementId }),
      ];
    };

    it("signed out: sent to sign-in, nothing changes", async () => {
      state.user = null;
      await expect(actions.startSessionAction({}, form({ companyId: acme, contentType: "design_poster" }))).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(actions.saveRequirementAction({}, form({ sessionId: deesSession, type: "offer", expected_value: "x" }))).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(actions.prepareUploadAction({ sessionId: deesSession, kind: "content", name: "x.png", size: 1, type: "" })).rejects.toThrow("NEXT_REDIRECT /login");
      expect(await listRequirements(state.db, deesSession)).toHaveLength(1);
    });

    it("another designer of the same company can't use Dee's session — by ID or requirement", async () => {
      state.user = sam;
      const [requirement] = await listRequirements(state.db, deesSession);
      for (const result of await everyAction(deesSession, requirement.id)) {
        expect(result).toMatchObject({ error: expect.stringMatching(/isn't available/) });
      }
      expect(fake.calls).toEqual([]); // Storage never touched
      const after = await listRequirements(state.db, deesSession);
      expect(after.map((r) => [r.expected_value, r.confirmed])).toEqual([["20% off", false]]);
    });

    it("Sam's own session can't reach Dee's requirements or files by putting their IDs in the form", async () => {
      // Dee's design, uploaded into Dee's session.
      const prepared = await actions.prepareUploadAction({ sessionId: deesSession, kind: "content", name: "poster.png", size: PNG.length, type: "image/png" });
      if (!prepared.ok) throw new Error(prepared.error);
      const deesFile = fake.browserPut(prepared.uploadUrl, PNG);
      expect(await actions.confirmUploadAction({ sessionId: deesSession, fileId: prepared.fileId })).toEqual({ ok: true });
      const [deesRequirement] = await listRequirements(state.db, deesSession);

      // Sam, a member of the same company, with a session of his own.
      state.user = sam;
      await actions.startSessionAction({}, form({ companyId: acme, contentType: "design_poster" }));
      const samsSession = (await sessionOf(sam, acme)).id;
      const notAvailable = { error: expect.stringMatching(/isn't available/) };
      expect(await actions.saveRequirementAction({}, form({ sessionId: samsSession, requirementId: deesRequirement.id, type: "offer", expected_value: "hijacked" }))).toMatchObject(notAvailable);
      expect(await actions.setRequirementConfirmedAction({}, form({ sessionId: samsSession, requirementId: deesRequirement.id, confirmed: "true" }))).toMatchObject(notAvailable);
      expect(await actions.deleteRequirementAction({}, form({ sessionId: samsSession, requirementId: deesRequirement.id }))).toMatchObject(notAvailable);
      expect(await actions.removeFileAction({}, form({ sessionId: samsSession, fileId: prepared.fileId }))).toMatchObject({ error: expect.any(String) });
      expect(await actions.confirmUploadAction({ sessionId: samsSession, fileId: prepared.fileId })).toMatchObject({ ok: false });
      await actions.cancelUploadAction({ sessionId: samsSession, fileId: prepared.fileId });
      // Replacing names a file of Dee's: Sam's upload goes into his own session; Dee's file is untouched.
      const replacing = await actions.prepareUploadAction({ sessionId: samsSession, kind: "content", name: "x.png", size: PNG.length, type: "image/png", replacing: prepared.fileId });
      if (replacing.ok) expect(fake.browserPut(replacing.uploadUrl, PNG)).toMatch(new RegExp(`^${samsSession}/`));

      // Dee's requirement and file are exactly as they were.
      expect((await listRequirements(state.db, deesSession)).map((r) => [r.id, r.expected_value, r.confirmed])).toEqual([[deesRequirement.id, "20% off", false]]);
      expect((await listFiles(state.db, deesSession)).map((f) => f.id)).toEqual([prepared.fileId]);
      expect(fake.files.has(deesFile)).toBe(true);
    });

    it("even an admin can't open another designer's session", async () => {
      state.user = ada;
      for (const result of await everyAction(deesSession)) {
        expect(result).toMatchObject({ error: expect.stringMatching(/isn't available/) });
      }
    });

    it("forged, junk and expired session IDs are refused", async () => {
      for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid", `${deesSession}/..`, undefined]) {
        for (const result of await everyAction(id)) expect(result, String(id)).toMatchObject({ error: expect.any(String) });
      }
      await state.db.query("update qc_sessions set expires_at = now() - interval '1 minute' where id = $1", [deesSession]);
      for (const result of await everyAction(deesSession)) expect(result).toMatchObject({ error: /isn't available/ });
    });

    it("losing company membership closes the session too", async () => {
      await state.db.query("delete from company_members where company_id = $1 and user_id = $2", [acme, dee.id]);
      try {
        for (const result of await everyAction(deesSession)) expect(result).toMatchObject({ error: /isn't available/ });
      } finally {
        await addCompanyMember(state.db, acme, dee.id);
      }
    });

    it("a non-member can't start QC for a company", async () => {
      expect(await actions.startSessionAction({}, form({ companyId: globex, contentType: "design_poster" }))).toEqual({
        error: "This company isn't available. Reload the page and try again.",
      });
      expect(await actions.startSessionAction({}, form({ companyId: "not-a-uuid", contentType: "design_poster" }))).toMatchObject({ error: expect.any(String) });
    });
  });

  describe("a check can't be removed while its analysis is waiting or running", () => {
    const RUNNING = /still waiting or running\. Wait until it finishes/;
    const upload = async (sessionId: string) => {
      const prepared = await actions.prepareUploadAction({ sessionId, kind: "content", name: "poster.png", size: PNG.length, type: "image/png" });
      if (!prepared.ok) throw new Error(prepared.error);
      const path = fake.browserPut(prepared.uploadUrl, PNG);
      expect(await actions.confirmUploadAction({ sessionId, fileId: prepared.fileId })).toEqual({ ok: true });
      return path;
    };
    const runIn = (sessionId: string, status: "queued" | "processing" | "done", kind: "content" | "information" = "content") =>
      state.db.query(
        `insert into qc_analysis_runs (session_id, requested_by, kind, provider, status, files_fingerprint, started_at, heartbeat_at)
         values ($1, $2, $3, 'mock', $4, 'x', case when $4 = 'queued' then null else now() end, case when $4 = 'processing' then now() else null end)`,
        [sessionId, dee.id, kind, status]
      );
    const activeRuns = () => state.db.query("select id from qc_analysis_runs where status in ('queued', 'processing')");
    let check: string;
    let file: string;
    beforeEach(async () => {
      await actions.startSessionAction({}, form({ companyId: acme, contentType: "design_poster" }));
      check = (await sessionOf(dee, acme)).id;
      file = await upload(check);
    });
    const stillThere = async () => {
      expect((await sessionOf(dee, acme)).id).toBe(check);
      expect(fake.files.has(file)).toBe(true);
    };

    for (const status of ["queued", "processing"] as const) {
      it(`Start over is refused while a design check is ${status} — even called directly — and nothing is removed`, async () => {
        await runIn(check, status);
        expect(await actions.startOverAction({}, form({ sessionId: check }))).toEqual({
          error: "This check's design check or brief reading is still waiting or running. Wait until it finishes, then try again.",
        });
        await stillThere();
        expect(await activeRuns()).toHaveLength(1); // still counted towards the 2 at once
      });

      it(`Start a new check is refused while a brief reading is ${status}`, async () => {
        await runIn(check, "done"); // a finished design check: the check is complete
        await runIn(check, status, "information");
        expect(await actions.startNewCheckAction({}, form({ companyId: acme, sessionId: check, contentType: "design_poster" }))).toMatchObject({ error: expect.stringMatching(RUNNING) });
        await stillThere();
      });

      it(`an expired check isn't replaced while its analysis is ${status}`, async () => {
        await runIn(check, status);
        await state.db.query("update qc_sessions set expires_at = now() - interval '1 minute' where id = $1", [check]);
        expect(await actions.startSessionAction({}, form({ companyId: acme, contentType: "design_poster" }))).toMatchObject({ error: expect.stringMatching(RUNNING) });
        expect(await state.db.query("select id from qc_sessions where id = $1", [check])).toHaveLength(1);
        expect(fake.files.has(file)).toBe(true);
        expect(await activeRuns()).toHaveLength(1);
      });
    }

    it("once the analysis has finished, Start over works again", async () => {
      await runIn(check, "processing");
      expect(await actions.startOverAction({}, form({ sessionId: check }))).toMatchObject({ error: expect.stringMatching(RUNNING) });
      await state.db.query("update qc_analysis_runs set status = 'done', finished_at = now() where session_id = $1", [check]);
      expect(await actions.startOverAction({}, form({ sessionId: check }))).toEqual({ ok: true });
      expect(await findCurrentSession(state.db, acme, dee.id, new Date())).toBeNull();
      expect(fake.files.has(file)).toBe(false);
    });

    for (const status of ["queued", "processing"] as const) {
      it(`the hourly clean-up keeps an expired check while its analysis is ${status}, and removes it once finished`, async () => {
        await runIn(check, status);
        await state.db.query("update qc_sessions set expires_at = now() - interval '1 hour' where id = $1", [check]);
        expect(await purgeExpiredBatch(state.db, fake.bucket, new Date(), null)).toMatchObject({ removed: 0, kept: 1 });
        expect(await state.db.query("select id from qc_sessions where id = $1", [check])).toHaveLength(1);
        expect(fake.files.has(file)).toBe(true);
        expect(await activeRuns()).toHaveLength(1);
        // Finished: the next sweep removes it, files first.
        await state.db.query("update qc_analysis_runs set status = 'done', finished_at = now() where session_id = $1", [check]);
        expect(await purgeExpiredBatch(state.db, fake.bucket, new Date(), null)).toMatchObject({ removed: 1, kept: 0 });
        expect(await state.db.query("select id from qc_sessions where id = $1", [check])).toHaveLength(0);
        expect(fake.files.has(file)).toBe(false);
      });

      it(`the session row itself is never deleted while a run is ${status} (whoever asks)`, async () => {
        await runIn(check, status);
        expect(await deleteSessionRow(state.db, check)).toBe(false);
        expect(await state.db.query("select id from qc_sessions where id = $1", [check])).toHaveLength(1);
        expect(await activeRuns()).toHaveLength(1);
      });
    }

    /**
     * "Analyse again" in another tab, sent while the check is being removed (its files being deleted). The
     * removal holds a lock on the check, so the analysis waits — and is then refused, as the check is gone:
     * it is never queued for files that were just deleted, so it can't fail later or be counted as running.
     */
    const analyseDuringRemoval = () => {
      let queued: Promise<unknown> | null = null;
      const remove = fake.bucket.remove;
      fake.bucket.remove = async (paths) => {
        queued ??= runIn(check, "queued"); // sent now; not awaited (it waits for the removal)
        return remove(paths);
      };
      return {
        settled: async () => {
          fake.bucket.remove = remove;
          return queued;
        },
      };
    };

    it("two tabs: an analysis sent while Start over is removing the check waits, then is refused — never queued for deleted files", async () => {
      const other = analyseDuringRemoval();
      expect(await actions.startOverAction({}, form({ sessionId: check }))).toEqual({ ok: true });
      await expect(other.settled()).rejects.toThrow(/foreign key/);
      expect(await findCurrentSession(state.db, acme, dee.id, new Date())).toBeNull();
      expect(fake.files.has(file)).toBe(false);
      expect(await state.db.query("select id from qc_analysis_runs")).toHaveLength(0); // nothing left to fail or to count
    });

    it("two tabs: the same while an expired check is being replaced", async () => {
      await state.db.query("update qc_sessions set expires_at = now() - interval '1 minute' where id = $1", [check]);
      const other = analyseDuringRemoval();
      expect(await actions.startSessionAction({}, form({ companyId: acme, contentType: "design_poster" }))).toEqual({ ok: true });
      await expect(other.settled()).rejects.toThrow(/foreign key/);
      expect(await state.db.query("select id from qc_sessions where id = $1", [check])).toHaveLength(0);
      expect(await state.db.query("select id from qc_analysis_runs")).toHaveLength(0);
    });

    it("the removal locks the check before looking for analyses, and holds the lock while deleting its files", async () => {
      const events: string[] = [];
      const record = (db: Database, inTx: boolean): Database => ({
        exec: (script) => db.exec(script),
        query: (text, params) => {
          if (/for update|qc_analysis_runs|delete from qc_sessions/.test(text)) events.push(`${inTx ? "tx" : "db"}: ${text.replace(/\s+/g, " ").trim().slice(0, 40)}`);
          return db.query(text, params);
        },
        transaction: (fn) => db.transaction((tx) => fn(record(tx, true))),
      });
      const remove = fake.bucket.remove;
      fake.bucket.remove = async (paths) => {
        events.push("storage: remove");
        return remove(paths);
      };
      try {
        expect(await removeSessionCompletely(record(state.db, false), fake.bucket, check)).toBe(true);
      } finally {
        fake.bucket.remove = remove;
      }
      expect(events).toEqual([
        "tx: select id from qc_sessions where id = $1",
        "tx: select 1 from qc_analysis_runs where ses",
        "storage: remove",
        "tx: delete from qc_sessions s where s.id = $",
      ]);
    });

    /** Nothing is left behind once a removal has ended, however it ended. */
    const nothingLeftBehind = async () => {
      // No lock on any session row (PGlite would also wait here forever if the transaction were still open).
      expect(await state.db.query("select 1 from pg_locks where relation = 'qc_sessions'::regclass")).toHaveLength(0);
      await state.db.query("update qc_sessions set updated_at = updated_at where id = $1", [check]);
      // The time limits were LOCAL to the transaction: the (pooled) connection is back to its defaults.
      for (const setting of ["lock_timeout", "statement_timeout", "idle_in_transaction_session_timeout"]) {
        expect([setting, (await state.db.query<Record<string, string>>(`show ${setting}`))[0][setting]]).toEqual([setting, "0"]);
      }
    };

    it("Storage failing: everything is rolled back — the check, its records and files are kept — and no lock remains", async () => {
      fake.failing.remove = true;
      try {
        expect(await removeSessionCompletely(state.db, fake.bucket, check)).toBe(false);
        expect(await actions.startOverAction({}, form({ sessionId: check }))).toEqual({ error: "The session couldn't be cleared right now. Please try again in a moment." });
      } finally {
        fake.failing.remove = false;
      }
      await stillThere();
      expect(await listFiles(state.db, check)).toHaveLength(1);
      await nothingLeftBehind();
      // The next try works.
      expect(await removeSessionCompletely(state.db, fake.bucket, check)).toBe(true);
      expect(await state.db.query("select id from qc_sessions where id = $1", [check])).toHaveLength(0);
    });

    it("a database error in the middle: rolled back (the check is kept, to retry), the error is reported, no lock remains", async () => {
      const failingDelete = (db: Database): Database => ({
        exec: (script) => db.exec(script),
        query: (text, params) => (/delete from qc_sessions/.test(text) ? Promise.reject(new Error("db down")) : db.query(text, params)),
        transaction: (fn) => db.transaction((tx) => fn(failingDelete(tx))),
      });
      await expect(removeSessionCompletely(failingDelete(state.db), fake.bucket, check)).rejects.toThrow("db down");
      expect(await state.db.query("select id from qc_sessions where id = $1", [check])).toHaveLength(1);
      expect(await listFiles(state.db, check)).toHaveLength(1); // its records too
      await nothingLeftBehind();
      // Its files were already deleted; the next clean-up finds none and removes the check.
      expect(await removeSessionCompletely(state.db, fake.bucket, check)).toBe(true);
    });

    it("waiting too long for the lock (another removal holds it): kept for now, no error", async () => {
      const lockTimeout = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      const busy = (db: Database): Database => ({
        exec: (script) => db.exec(script),
        query: (text, params) => (/for update/.test(text) ? Promise.reject(lockTimeout) : db.query(text, params)),
        transaction: (fn) => db.transaction((tx) => fn(busy(tx))),
      });
      expect(await removeSessionCompletely(busy(state.db), fake.bucket, check)).toBe(false);
      await stillThere();
      await nothingLeftBehind();
    });

    it("a successful removal leaves no lock and no setting behind either", async () => {
      expect(await removeSessionCompletely(state.db, fake.bucket, check)).toBe(true);
      expect(await state.db.query("select 1 from pg_locks where relation = 'qc_sessions'::regclass")).toHaveLength(0);
      for (const setting of ["lock_timeout", "statement_timeout", "idle_in_transaction_session_timeout"]) {
        expect((await state.db.query<Record<string, string>>(`show ${setting}`))[0][setting]).toBe("0");
      }
    });

    it("direct calls by anyone else, or signed out, change nothing (and don't reveal the analysis)", async () => {
      await runIn(check, "processing");
      for (const someone of [sam, ada]) {
        state.user = someone;
        expect(await actions.startOverAction({}, form({ sessionId: check }))).toEqual({ error: "This QC session isn't available any more. Reload the page." });
        expect(await actions.startNewCheckAction({}, form({ companyId: acme, sessionId: check, contentType: "design_poster" }))).toEqual({ error: "This QC session isn't available any more. Reload the page." });
      }
      state.user = null;
      await expect(actions.startOverAction({}, form({ sessionId: check }))).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(actions.startNewCheckAction({}, form({ companyId: acme, sessionId: check, contentType: "design_poster" }))).rejects.toThrow("NEXT_REDIRECT /login");
      state.user = dee;
      await stillThere();
      expect(await activeRuns()).toHaveLength(1);
    });
  });

  it("says so plainly when file storage isn't set up", async () => {
    await actions.startSessionAction({}, form({ companyId: acme, contentType: "design_poster" }));
    const { id: sessionId } = await sessionOf(dee, acme);
    state.storage = null;
    expect(await actions.prepareUploadAction({ sessionId, kind: "content", name: "a.png", size: 10, type: "" })).toEqual({
      ok: false,
      error: "File storage isn't set up on this server yet. Ask your administrator.",
    });
  });
});
