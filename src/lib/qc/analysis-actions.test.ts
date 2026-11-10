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
const { findCurrentSession, listFiles, listRequirements } = await import("@/lib/db/qc-sessions");
const { filesFingerprint } = await import("@/lib/analysis/pipeline");

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
    await state.db.query("delete from login_throttle"); // the per-user AI counts
    vi.spyOn(console, "error").mockImplementation(() => {});
    await actions.startSessionAction({}, form({ companyId: acme, contentType: "social_post" }));
    sessionId = (await findCurrentSession(state.db, acme, dee.id, new Date()))!.id;
  });

  const addRequirement = (values: Record<string, string> = {}) =>
    actions.saveRequirementAction({}, form({ sessionId, type: "price", expected_value: "AED 1,299", mandatory: "on", ...values }));
  const confirmAll = () => state.db.query("update qc_requirements set confirmed = true where session_id = $1", [sessionId]);
  const infoFingerprint = async () => {
    const files = (await listFiles(state.db, sessionId, "ready")).filter((f) => f.kind === "information");
    return filesFingerprint(files);
  };

  it("Check Design confirms every requirement and queues a content analysis run for the owner", async () => {
    await upload("content", "post.png", pngOf(1440, 1800));
    await actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "feed_image" }));
    await addRequirement();
    await addRequirement({ type: "cta", expected_value: "Book now" });
    expect((await listRequirements(state.db, sessionId)).some((r) => r.confirmed)).toBe(false);
    expect(await actions.markReadyAction({}, form({ sessionId }))).toMatchObject({ ok: true, message: "Checking the design…" });
    expect((await listRequirements(state.db, sessionId)).every((r) => r.confirmed)).toBe(true);
    expect(await runs()).toEqual([{ status: "queued", requested_by: dee.id, kind: "content" }]);
    expect(await actions.analysisStatusAction(sessionId)).toMatchObject({ status: "queued", kind: "content", mock: true });
  });

  it("no requirements: Check Design and Try again are both blocked — never a PASS with nothing to check against", async () => {
    await upload("content", "post.png", pngOf(1440, 1800));
    await actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "feed_image" }));
    const blocked = { error: "Add or confirm the client's requirements before running QC." };
    expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual({ error: "Upload or type the client brief." });
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual(blocked);
    // A brief that gave nothing checkable (only descriptive items): the clearer-brief message.
    await upload("information", "brief.txt", new TextEncoder().encode("Summer campaign"));
    await state.db.query("update qc_analysis_runs set status = 'done' where session_id = $1", [sessionId]);
    await addRequirement({ type: "special_instruction", expected_value: "Make it feel summery" });
    expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual({
      error: "We couldn't find clear requirements in this brief. Please upload a clearer brief.",
    });
    expect((await runs()).filter((r) => r.kind === "content")).toEqual([]);
    // Unconfirmed requirements don't count for Try again either (Check Design confirms them).
    await addRequirement();
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual(blocked);
    expect((await runs()).filter((r) => r.kind === "content")).toEqual([]);
    expect((await findCurrentSession(state.db, acme, dee.id, new Date()))!.status).toBe("draft");
  });

  it("Analyse again: one active run; then 'already running'", async () => {
    await upload("content", "post.png", pngOf(1440, 1800));
    await addRequirement();
    await confirmAll();
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ ok: true });
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ error: "An analysis is already running for this session." });
  });

  it("nothing to analyse, or not set up on this server", async () => {
    await addRequirement();
    await confirmAll();
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ error: "Upload the content first." });
    await upload("content", "post.png", pngOf(1440, 1800));
    delete process.env.QC_ANALYSIS_PROVIDER;
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ error: "Content analysis isn't set up on this server." });
  });

  it("uploading the brief starts reading it automatically: an information run, polled separately from the content run", async () => {
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "information" }))).toMatchObject({ error: expect.any(String) });
    await upload("information", "brief.txt", new TextEncoder().encode("Price AED 1,299"));
    expect(await runs()).toEqual([{ status: "queued", requested_by: dee.id, kind: "information" }]);
    expect(await actions.analysisStatusAction(sessionId, "information")).toMatchObject({ status: "queued", kind: "information" });
    expect(await actions.analysisStatusAction(sessionId, "content")).toBeNull();

    // A second file while the first reading is still waiting: the same run takes it in.
    await upload("information", "email.txt", new TextEncoder().encode("CTA: Book now"));
    expect(await runs()).toHaveLength(1);
    const [run] = await state.db.query<{ files_fingerprint: string }>("select files_fingerprint from qc_analysis_runs where session_id = $1", [sessionId]);
    expect(run.files_fingerprint).toBe(await infoFingerprint());
    expect(run.files_fingerprint.startsWith("2:")).toBe(true);
  });

  it("Confirm & Run QC waits while the brief is still being read", async () => {
    await upload("content", "post.png", pngOf(1440, 1800));
    await actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "feed_image" }));
    await upload("information", "brief.txt", new TextEncoder().encode("Price AED 1,299"));
    expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual({ error: expect.stringMatching(/still being read/) });
    await state.db.query("update qc_analysis_runs set status = 'done' where session_id = $1", [sessionId]);
    await addRequirement();
    expect(await actions.markReadyAction({}, form({ sessionId }))).toMatchObject({ ok: true });
  });

  it("if the brief can't be read straight away (a design is being analysed), Read the brief is offered instead", async () => {
    await upload("content", "post.png", pngOf(1440, 1800));
    await addRequirement();
    await confirmAll();
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ ok: true });
    await upload("information", "brief.txt", new TextEncoder().encode("Price AED 1,299"));
    expect(await runs()).toEqual([{ status: "queued", requested_by: dee.id, kind: "content" }]);
    await state.db.query("update qc_analysis_runs set status = 'done' where session_id = $1", [sessionId]);
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "information" }))).toEqual({ ok: true });
  });

  it("at most 5 runs per session", async () => {
    await upload("content", "post.png", pngOf(1440, 1800));
    await addRequirement();
    await confirmAll();
    for (let i = 0; i < 5; i++) {
      expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ ok: true });
      await state.db.query("update qc_analysis_runs set status = 'done' where session_id = $1", [sessionId]);
    }
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toMatchObject({ error: expect.stringMatching(/used its 5 analysis runs/) });
    expect(await runs()).toHaveLength(5);
  });

  it("reading the brief never uses up a design analysis run", async () => {
    const done = () => state.db.query("update qc_analysis_runs set status = 'done' where session_id = $1", [sessionId]);
    // Six brief readings (more than the limit): automatic on upload, then Read again.
    await upload("information", "brief.txt", new TextEncoder().encode("Price AED 1,299"));
    await done();
    for (let i = 0; i < 5; i++) {
      expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "information" }))).toEqual({ ok: true });
      await done();
    }
    expect((await runs()).filter((r) => r.kind === "information")).toHaveLength(6);

    // All 5 design analyses are still available — and the 6th is still refused.
    await upload("content", "post.png", pngOf(1440, 1800));
    await addRequirement();
    await confirmAll();
    for (let i = 0; i < 5; i++) {
      expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ ok: true });
      await done();
    }
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toMatchObject({ error: expect.stringMatching(/used its 5 analysis runs/) });
    expect((await runs()).filter((r) => r.kind === "content")).toHaveLength(5);

    // With the design runs used up, the brief can still be read.
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "information" }))).toEqual({ ok: true });
  });

  it("Check Design counts as a design analysis run", async () => {
    await upload("content", "post.png", pngOf(1440, 1800));
    await actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "feed_image" }));
    await addRequirement();
    await state.db.query(
      `insert into qc_analysis_runs (session_id, requested_by, kind, provider, files_fingerprint, status, created_at)
       select $1, $2, 'content', 'mock', 'x', 'done', now() from generate_series(1, 4)`,
      [sessionId, dee.id]
    );
    expect(await actions.markReadyAction({}, form({ sessionId }))).toMatchObject({ ok: true, message: "Checking the design…" });
    await state.db.query("update qc_analysis_runs set status = 'done' where session_id = $1", [sessionId]);
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toMatchObject({ error: expect.stringMatching(/used its 5 analysis runs/) });
  });

  describe("per-user AI limits: 30 analyses a day (design checks and brief readings together), 2 at once", () => {
    const usageRows = () => state.db.query<{ key: string }>("select key from login_throttle where key like 'ai:' || $1 || ':%'", [dee.id]);
    /** `count` analyses already used by Dee, `hoursAgo` hours ago (not tied to any session). */
    const used = (count: number, hoursAgo = 1) =>
      state.db.query(
        `insert into login_throttle (key, attempts, window_started_at)
         select 'ai:' || $1 || ':' || gen_random_uuid(), 1, now() - ($3::int * interval '1 hour') from generate_series(1, $2::int)`,
        [dee.id, count, hoursAgo]
      );
    const done = () => state.db.query("update qc_analysis_runs set status = 'done' where requested_by = $1", [dee.id]);
    /** A check of Dee's for `companyId`, with a design and a confirmed requirement: ready to analyse. */
    async function readyCheck(companyId: string) {
      await actions.startSessionAction({}, form({ companyId, contentType: "social_post" }));
      sessionId = (await findCurrentSession(state.db, companyId, dee.id, new Date()))!.id;
      await upload("content", "post.png", pngOf(1440, 1800));
      await addRequirement();
      await confirmAll();
      return sessionId;
    }
    let beta: string;
    let gamma: string;
    beforeAll(async () => {
      beta = (await insertCompany(state.db, { name: "Beta", createdBy: dee.id })).id;
      gamma = (await insertCompany(state.db, { name: "Gamma", createdBy: dee.id })).id;
    });

    it("the 30th analysis in 24 hours runs; the 31st is refused with a clear message, withdrawn and not counted", async () => {
      const check = await readyCheck(acme);
      await used(29, 3);
      expect(await actions.startAnalysisAction({}, form({ sessionId: check }))).toEqual({ ok: true });
      await done();
      const refused = await actions.startAnalysisAction({}, form({ sessionId: check }));
      expect(refused).toEqual({
        error: "You've used your 30 AI checks for the last 24 hours (design checks and brief readings together). You can start another in about 21 hours, or ask an admin.",
      });
      expect(await usageRows()).toHaveLength(30);
      expect((await runs()).filter((r) => r.status === "queued")).toHaveLength(0); // the refused run never waits for the worker
    });

    it("the limit survives Start over and a new check, and a brief reading counts too", async () => {
      await used(30);
      const check = await readyCheck(acme);
      expect(await actions.startAnalysisAction({}, form({ sessionId: check }))).toMatchObject({ error: expect.stringMatching(/used your 30 AI checks/) });
      // Check Design says so too (the design stays ready).
      expect(await actions.markReadyAction({}, form({ sessionId: check }))).toMatchObject({ error: expect.stringMatching(/used your 30 AI checks/) });
      // Start over, then a fresh check: still refused.
      expect(await actions.startOverAction({}, form({ sessionId: check }))).toEqual({ ok: true });
      const fresh = await readyCheck(acme);
      expect(await actions.startAnalysisAction({}, form({ sessionId: fresh }))).toMatchObject({ error: expect.stringMatching(/used your 30 AI checks/) });
      // Reading the brief counts towards the same 30.
      await upload("information", "brief.txt", new TextEncoder().encode("Price AED 1,299"));
      expect(await actions.startAnalysisAction({}, form({ sessionId: fresh, kind: "information" }))).toMatchObject({ error: expect.stringMatching(/used your 30 AI checks/) });
      expect(await state.db.query("select id from qc_analysis_runs")).toHaveLength(0);
      expect(await usageRows()).toHaveLength(30);
    });

    it("it's a rolling 24 hours: analyses older than that no longer count", async () => {
      await used(29, 25);
      await used(1, 2);
      const check = await readyCheck(acme);
      expect(await actions.startAnalysisAction({}, form({ sessionId: check }))).toEqual({ ok: true });
      expect(await usageRows()).toHaveLength(2); // the old ones are forgotten
    });

    it("another designer has their own 30", async () => {
      await used(30);
      state.user = sam;
      await actions.startSessionAction({}, form({ companyId: acme, contentType: "social_post" }));
      sessionId = (await findCurrentSession(state.db, acme, sam.id, new Date()))!.id;
      await upload("content", "post.png", pngOf(1440, 1800));
      await addRequirement();
      await confirmAll();
      expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ ok: true });
    });

    it("at most 2 waiting or running at once, across all the user's checks", async () => {
      const first = await readyCheck(acme);
      const second = await readyCheck(beta);
      const third = await readyCheck(gamma);
      expect(await actions.startAnalysisAction({}, form({ sessionId: first }))).toEqual({ ok: true });
      expect(await actions.startAnalysisAction({}, form({ sessionId: second }))).toEqual({ ok: true });
      expect(await actions.startAnalysisAction({}, form({ sessionId: third }))).toEqual({
        error: "You already have 2 AI checks waiting or running. Wait for one to finish, then try again.",
      });
      expect(await state.db.query("select id from qc_analysis_runs where session_id = $1", [third])).toHaveLength(0);
      expect(await usageRows()).toHaveLength(2); // the refused one isn't counted
      // One finishes: the third can start.
      await state.db.query("update qc_analysis_runs set status = 'done' where session_id = $1", [first]);
      expect(await actions.startAnalysisAction({}, form({ sessionId: third }))).toEqual({ ok: true });
    });

    it("a refused analysis is never written as a run, so no worker can ever pick it up", async () => {
      // Every row ever written to the runs table is logged, whatever happens to it afterwards.
      await state.db.query("create table if not exists run_inserts (id uuid)");
      await state.db.query("delete from run_inserts");
      await state.db.query(
        `create or replace function log_run_insert() returns trigger language plpgsql as $$ begin insert into run_inserts values (new.id); return new; end $$`
      );
      await state.db.query("drop trigger if exists log_run_insert on qc_analysis_runs");
      await state.db.query("create trigger log_run_insert after insert on qc_analysis_runs for each row execute function log_run_insert()");
      try {
        const check = await readyCheck(acme);
        await used(30);
        expect(await actions.startAnalysisAction({}, form({ sessionId: check }))).toMatchObject({ error: expect.stringMatching(/used your 30 AI checks/) });
        await state.db.query("delete from login_throttle");
        const busy = [await readyCheck(beta), await readyCheck(gamma)];
        for (const id of busy) expect(await actions.startAnalysisAction({}, form({ sessionId: id }))).toEqual({ ok: true });
        expect(await actions.startAnalysisAction({}, form({ sessionId: check }))).toMatchObject({ error: expect.stringMatching(/2 AI checks waiting or running/) });
        // Only the two accepted runs were ever written; nothing is left queued for the refused ones.
        expect((await state.db.query<{ id: string }>("select id from run_inserts")).length).toBe(2);
        expect(await state.db.query("select id from qc_analysis_runs where session_id = $1", [check])).toHaveLength(0);
      } finally {
        await state.db.query("drop trigger if exists log_run_insert on qc_analysis_runs");
      }
    });

    it("a request still being queued elsewhere (another server or connection) holds its place; a stale one stops after 2 minutes", async () => {
      const [first, second] = [await readyCheck(acme), await readyCheck(beta)];
      expect(await actions.startAnalysisAction({}, form({ sessionId: first }))).toEqual({ ok: true });
      // Another request of Dee's has reserved its place and not yet queued its run.
      const slot = (minutesAgo: number) =>
        state.db.query("insert into login_throttle (key, attempts, window_started_at) values ('ai-slot:' || $1 || ':' || gen_random_uuid(), 1, now() - ($2::int * interval '1 minute'))", [dee.id, minutesAgo]);
      await slot(0);
      expect(await actions.startAnalysisAction({}, form({ sessionId: second }))).toMatchObject({ error: expect.stringMatching(/2 AI checks waiting or running/) });
      // A reservation left behind 3 minutes ago (a crash) no longer counts.
      await state.db.query("delete from login_throttle where key like 'ai-slot:%'");
      await slot(3);
      expect(await actions.startAnalysisAction({}, form({ sessionId: second }))).toEqual({ ok: true });
      // Each accepted run keeps its place in the 24 hours, but holds no reservation once queued.
      expect(await usageRows()).toHaveLength(2);
      expect(await state.db.query("select key from login_throttle where key like 'ai-slot:%' and window_started_at > now() - interval '2 minutes'")).toHaveLength(0);
    });

    it("a brief uploaded while a reading is still waiting joins that reading — not refused, not counted again", async () => {
      await used(29);
      await actions.startSessionAction({}, form({ companyId: acme, contentType: "social_post" }));
      sessionId = (await findCurrentSession(state.db, acme, dee.id, new Date()))!.id;
      await upload("information", "brief-1.txt", new TextEncoder().encode("Price AED 1,299"));
      await upload("information", "brief-2.txt", new TextEncoder().encode("Valid until 31 Dec 2026"));
      expect((await runs()).filter((r) => r.kind === "information")).toHaveLength(1);
      expect(await usageRows()).toHaveLength(30);
    });

    it("requests sent at the same moment can't get past either limit", async () => {
      const checks = [await readyCheck(acme), await readyCheck(beta), await readyCheck(gamma)];
      // Two at once: at most 2 run.
      const together = await Promise.all(checks.map((id) => actions.startAnalysisAction({}, form({ sessionId: id }))));
      expect(together.filter((r) => r.ok).length).toBeLessThanOrEqual(2);
      expect(Number((await state.db.query<{ n: number }>("select count(*)::int as n from qc_analysis_runs where status in ('queued', 'processing')"))[0].n)).toBeLessThanOrEqual(2);
      await done();
      // One left of the 30: of three at once, at most one runs.
      const usedSoFar = (await usageRows()).length;
      await used(29 - usedSoFar);
      const lastOne = await Promise.all(checks.map((id) => actions.startAnalysisAction({}, form({ sessionId: id }))));
      expect(lastOne.filter((r) => r.ok).length).toBeLessThanOrEqual(1);
      expect((await usageRows()).length).toBeLessThanOrEqual(30);
      for (const r of [...together, ...lastOne]) if (!r.ok) expect(r.error).toMatch(/AI checks/);
    });
  });

  describe("authorization", () => {
    beforeEach(async () => {
      await upload("content", "post.png", pngOf(1440, 1800));
      await addRequirement();
      await confirmAll();
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
