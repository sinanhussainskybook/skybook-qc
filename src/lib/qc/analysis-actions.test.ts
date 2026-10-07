import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeBucket } from "../../../test/fake-storage";
import { pngOf } from "../../../test/media-samples";
import type { Database } from "@/lib/db/database";
import type { User } from "@/lib/db/users";
import type { BucketClient } from "@/lib/storage/storage-api";

/**
 * Phase 6 server actions — queueing analysis and polling its status — with a
 * real (in-memory) PostgreSQL: authorization, ownership, membership, expiry,
 * limits, and Save and continue queueing a run.
 */

const state = vi.hoisted(() => ({ db: null as unknown as Database, user: null as User | null, storage: null as BucketClient | null }));

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
const { findCurrentSession } = await import("@/lib/db/qc-sessions");

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

describe("analysis actions", () => {
  let close: () => Promise<void>;
  let dee: User;
  let sam: User;
  let acme: string;
  let sessionId: string;
  let fake: ReturnType<typeof createFakeBucket>;

  const runs = () => state.db.query<{ status: string; requested_by: string; kind: string }>("select status, requested_by, kind from qc_analysis_runs where session_id = $1", [sessionId]);

  async function upload(kind: "content" | "information", name: string, bytes: Uint8Array) {
    const prepared = await actions.prepareUploadAction({ sessionId, kind, name, size: bytes.length, type: "" });
    if (!prepared.ok) throw new Error(prepared.error);
    fake.browserPut(prepared.uploadUrl, bytes);
    await actions.confirmUploadAction({ sessionId, fileId: prepared.fileId });
  }

  beforeAll(async () => {
    const test = await createTestDatabase();
    state.db = test.db;
    close = test.close;
    dee = await insertTestUser(test.db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    sam = await insertTestUser(test.db, { name: "Sam", email: "sam@skybook.com", role: "designer" });
    acme = (await insertCompany(test.db, { name: "Acme", createdBy: dee.id })).id;
    await addCompanyMember(test.db, acme, sam.id);
  });
  afterAll(async () => {
    delete process.env.QC_ANALYSIS_PROVIDER;
    await close();
  });
  beforeEach(async () => {
    process.env.QC_ANALYSIS_PROVIDER = "mock";
    fake = createFakeBucket();
    state.storage = fake.bucket;
    state.user = dee;
    await state.db.query("delete from qc_sessions");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await actions.startSessionAction({}, form({ companyId: acme, contentType: "social_post" }));
    sessionId = (await findCurrentSession(state.db, acme, dee.id, new Date()))!.id;
  });

  it("Save and continue queues a content analysis run for the owner", async () => {
    await upload("content", "post.png", pngOf(1440, 1800));
    await actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "feed_image" }));
    expect(await actions.markReadyAction({}, form({ sessionId }))).toMatchObject({ ok: true, message: "Saved. The content is being analysed." });
    expect(await runs()).toEqual([{ status: "queued", requested_by: dee.id, kind: "content" }]);
    expect(await actions.analysisStatusAction(sessionId)).toMatchObject({ status: "queued", kind: "content", mock: true });
  });

  it("Analyse now: one active run; then 'already running'", async () => {
    await upload("content", "post.png", pngOf(1440, 1800));
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ ok: true });
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ error: "An analysis is already running for this session." });
  });

  it("nothing to analyse, or not set up on this server", async () => {
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ error: "Upload the content first." });
    await upload("content", "post.png", pngOf(1440, 1800));
    delete process.env.QC_ANALYSIS_PROVIDER;
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ error: "Content analysis isn't set up on this server." });
  });

  it("Find requirements in these files: an information run, polled separately from the content run", async () => {
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "information" }))).toMatchObject({ error: expect.any(String) });
    await upload("information", "brief.txt", new TextEncoder().encode("Price AED 1,299"));
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "information" }))).toEqual({ ok: true });
    expect(await runs()).toEqual([{ status: "queued", requested_by: dee.id, kind: "information" }]);
    expect(await actions.analysisStatusAction(sessionId, "information")).toMatchObject({ status: "queued", kind: "information" });
    expect(await actions.analysisStatusAction(sessionId, "content")).toBeNull();
  });

  it("at most 5 runs per session", async () => {
    await upload("content", "post.png", pngOf(1440, 1800));
    for (let i = 0; i < 5; i++) {
      expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ ok: true });
      await state.db.query("update qc_analysis_runs set status = 'done' where session_id = $1", [sessionId]);
    }
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toMatchObject({ error: expect.stringMatching(/used its 5 analysis runs/) });
  });

  describe("authorization", () => {
    beforeEach(async () => {
      await upload("content", "post.png", pngOf(1440, 1800));
    });

    it("another designer of the same company, and an admin-free forged id, can't queue or read the run", async () => {
      state.user = sam;
      expect(await actions.startAnalysisAction({}, form({ sessionId }))).toMatchObject({ error: expect.stringMatching(/isn't available/) });
      expect(await actions.analysisStatusAction(sessionId)).toBeNull();
      for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid", ""]) {
        expect(await actions.startAnalysisAction({}, form({ sessionId: id }))).toMatchObject({ error: expect.any(String) });
        expect(await actions.analysisStatusAction(id)).toBeNull();
      }
      expect(await runs()).toEqual([]);
    });

    it("expired session or lost membership: refused", async () => {
      await state.db.query("update qc_sessions set expires_at = now() - interval '1 minute'");
      expect(await actions.startAnalysisAction({}, form({ sessionId }))).toMatchObject({ error: expect.stringMatching(/isn't available/) });
      await state.db.query("update qc_sessions set expires_at = now() + interval '1 hour'");
      await state.db.query("delete from company_members where company_id = $1 and user_id = $2", [acme, dee.id]);
      try {
        expect(await actions.startAnalysisAction({}, form({ sessionId }))).toMatchObject({ error: expect.stringMatching(/isn't available/) });
      } finally {
        await addCompanyMember(state.db, acme, dee.id);
      }
      expect(await runs()).toEqual([]);
    });

    it("signed out: sent to sign-in", async () => {
      state.user = null;
      await expect(actions.startAnalysisAction({}, form({ sessionId }))).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(actions.analysisStatusAction(sessionId)).rejects.toThrow("NEXT_REDIRECT /login");
    });
  });
});
