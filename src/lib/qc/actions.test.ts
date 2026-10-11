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
const { findCurrentSession, listRequirements, listFiles } = await import("@/lib/db/qc-sessions");

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
