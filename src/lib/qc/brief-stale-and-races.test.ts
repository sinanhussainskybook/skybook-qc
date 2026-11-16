import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeBucket } from "../../../test/fake-storage";
import { PNG } from "../../../test/logo-files";
import type { Database } from "@/lib/db/database";
import type { User } from "@/lib/db/users";
import type { BucketClient } from "@/lib/storage/storage-api";
import type { AnalysisProvider } from "@/lib/analysis/provider";

/**
 * Brief consistency, last two safeguards (Stage 2):
 *   1. sessions from before the deploy: a requirement read from a brief whose file is gone (no source
 *      file) is stale — never used by Check Design, Try again, the QC input or the AI's context;
 *      manually entered requirements stay usable;
 *   2. brief files changing while a reading runs or saves: the save is cancelled, nothing partial or
 *      orphaned is kept, and the designer is asked to read the updated brief again.
 * PGlite is one connection, so a truly concurrent removal can't be run here: the save's own checks are
 * driven by a database wrapper that shows the file set as it would look after a concurrent removal, and
 * removeFile is checked to take the file's lock before touching its requirements.
 */

const state = vi.hoisted(() => ({ db: null as unknown as Database, user: null as User | null, storage: null as BucketClient | null }));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (p: string) => {
    throw new Error(`NEXT_REDIRECT ${p}`);
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
const { insertCompany, findAccessibleCompany } = await import("@/lib/db/companies");
const { findCurrentSession, insertRequirement, listFiles, listRequirements } = await import("@/lib/db/qc-sessions");
const { claimNextRun, latestRun } = await import("@/lib/db/analysis-runs");
const { processRun, designContextOf } = await import("@/lib/analysis/pipeline");
const { MockProvider } = await import("@/lib/analysis/mock-provider");
const { PassThroughPreparer } = await import("@/lib/analysis/media/types");
const { READINESS_MESSAGES, removeFile } = await import("@/lib/qc/session");
const { loadQcInput } = await import("@/lib/qc/qc-input");
const { loadCompanyConfiguration } = await import("@/lib/db/company-config");
const { BRIEF_FILES_CHANGED_MESSAGE } = await import("@/lib/qc/brief-length");

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const text = (s: string) => new TextEncoder().encode(s);

/** A Database whose queries (also inside transactions) can be watched or changed by `hook`. */
type Hook = (sql: string, params: readonly unknown[], run: () => Promise<unknown[]>) => Promise<unknown[]>;
function intercept(db: Database, hook: Hook): Database {
  return {
    query: (async (sql: string, params: readonly unknown[] = []) => hook(sql, params, () => db.query(sql, params))) as Database["query"],
    exec: (script: string) => db.exec(script),
    transaction: (fn) => db.transaction((tx) => fn(intercept(tx, hook))),
  };
}

describe("stale requirements and brief changes while reading", () => {
  let close: () => Promise<void>;
  let dee: User;
  let acme: string;
  let sessionId: string;
  let fake: ReturnType<typeof createFakeBucket>;
  let tempRoot: string;
  let clock = 0;

  const allRows = () =>
    state.db.query<{ expected_value: string; source: string; source_file_id: string | null; confirmed: boolean }>(
      "select expected_value, source, source_file_id, confirmed from qc_requirements where session_id = $1 order by expected_value",
      [sessionId]
    );
  const orphans = async () => (await allRows()).filter((r) => r.source === "extracted" && r.source_file_id === null);
  const used = async () => (await listRequirements(state.db, sessionId)).map((r) => r.expected_value).sort();
  const fileId = async (name: string) => (await listFiles(state.db, sessionId)).find((f) => f.file_name === name)!.id;
  const designRuns = () => state.db.query("select id from qc_analysis_runs where session_id = $1 and kind = 'content'", [sessionId]);

  async function upload(kind: "content" | "information", name: string, bytes: Uint8Array) {
    const prepared = await actions.prepareUploadAction({ sessionId, kind, name, size: bytes.length, type: "" });
    if (!prepared.ok) throw new Error(prepared.error);
    fake.browserPut(prepared.uploadUrl, bytes);
    const confirmed = await actions.confirmUploadAction({ sessionId, fileId: prepared.fileId });
    if (!confirmed.ok) throw new Error(confirmed.error);
    await state.db.query("update qc_analysis_runs set created_at = now() + make_interval(secs => $2) where session_id = $1 and status = 'queued'", [sessionId, ++clock]);
  }
  /** The worker reads the brief once (what is queued, else a new reading), with this database and AI. */
  async function readOnce(db: Database = state.db, provider: AnalysisProvider = new MockProvider()) {
    if ((await latestRun(state.db, sessionId, "information"))?.status !== "queued") {
      expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "information" }))).toEqual({ ok: true });
      await state.db.query("update qc_analysis_runs set created_at = now() + make_interval(secs => $2) where session_id = $1 and status = 'queued'", [sessionId, ++clock]);
    }
    const run = (await claimNextRun(state.db, new Date(), "mock"))!;
    const result = await processRun({ db, storage: fake.bucket, logoStorage: null, provider, preparer: new PassThroughPreparer(), tempRoot, sleep: async () => {} }, run);
    return { result, run: (await latestRun(state.db, sessionId, "information"))! };
  }
  const company = async () => (await findAccessibleCompany(state.db, { id: dee.id, role: dee.role }, acme))!;
  const session = async () => (await findCurrentSession(state.db, acme, dee.id, new Date()))!;

  beforeAll(async () => {
    const test = await createTestDatabase();
    state.db = test.db;
    close = test.close;
    dee = await insertTestUser(test.db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    acme = (await insertCompany(test.db, { name: "Acme", createdBy: dee.id })).id;
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "qc-brief-races-"));
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
    await state.db.query("delete from analysis_usage"); // the per-user AI counts
    vi.spyOn(console, "error").mockImplementation(() => {});
    await actions.startSessionAction({}, form({ companyId: acme, contentType: "social_post" }));
    sessionId = (await session()).id;
    await upload("content", "post.png", PNG);
    await upload("information", "brief A.txt", text("Call +971 4 123 4567"));
    expect((await readOnce()).result).toBe("done");
  });

  describe("sessions from before the deploy: requirements read from a removed brief", () => {
    /** What the old code left behind: brief B read and confirmed, then removed — its requirement kept, with no source file. */
    async function leftFromRemovedBrief(value: string) {
      await state.db.query(
        "insert into qc_requirements (session_id, type, expected_value, mandatory, confirmed, source, source_file_id) values ($1, 'email', $2, true, true, 'extracted', null)",
        [sessionId, value]
      );
    }

    it("never used: not in Check Design's readiness, the QC input or the AI's context — and not deleted", async () => {
      // Only the stale one is checkable: A's reading found nothing checkable.
      await state.db.query("delete from qc_requirements where session_id = $1", [sessionId]);
      await leftFromRemovedBrief("old@removed-brief.com");
      expect(await used()).toEqual([]);
      expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual({ error: READINESS_MESSAGES.briefUnclear });
      expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "content" }))).toEqual({ error: READINESS_MESSAGES.requirements });
      expect(await designRuns()).toEqual([]);
      const input = await loadQcInput(state.db, await company(), await session());
      expect(input.requirements.map((r) => r.expectedValue)).not.toContain("old@removed-brief.com");
      const context = await designContextOf(state.db, sessionId, await loadCompanyConfiguration(state.db, await company()));
      expect(JSON.stringify(context)).not.toContain("old@removed-brief.com");
      expect((await orphans()).map((r) => r.expected_value)).toEqual(["old@removed-brief.com"]); // kept, unused
    });

    it("with the current brief's requirements: QC uses those only; the stale one is cleared by the next successful reading", async () => {
      await leftFromRemovedBrief("old@removed-brief.com");
      expect(await used()).toContain("+971 4 123 4567");
      expect(await used()).not.toContain("old@removed-brief.com");
      expect(await actions.markReadyAction({}, form({ sessionId }))).toMatchObject({ ok: true });
      const input = await loadQcInput(state.db, await company(), await session());
      expect(input.requirements.map((r) => r.expectedValue)).toContain("+971 4 123 4567");
      expect(input.requirements.map((r) => r.expectedValue)).not.toContain("old@removed-brief.com");
      await state.db.query("delete from qc_analysis_runs where session_id = $1 and kind = 'content'", [sessionId]);
      expect((await readOnce()).result).toBe("done");
      expect(await orphans()).toEqual([]);
    });

    it("manually entered requirements stay usable (they never have a source file)", async () => {
      await state.db.query("delete from qc_requirements where session_id = $1", [sessionId]);
      await leftFromRemovedBrief("old@removed-brief.com");
      await insertRequirement(state.db, sessionId, { type: "offer", label: null, expected_value: "20% off", notes: null, mandatory: true, confirmed: true }, new Date());
      expect(await used()).toEqual(["20% off"]);
      expect(await actions.markReadyAction({}, form({ sessionId }))).toMatchObject({ ok: true });
      const input = await loadQcInput(state.db, await company(), await session());
      expect(input.requirements.map((r) => r.expectedValue)).toEqual(["20% off"]);
    });
  });

  describe("brief files changing while a reading runs or saves", () => {
    it("a file removed during the reading (before saving): cancelled with the read-again message; nothing saved, nothing orphaned", async () => {
      await upload("information", "brief B.txt", text("Email sales@skybook.com"));
      const before = await allRows();
      const mock = new MockProvider();
      let removed = false;
      // The designer removes brief B while the AI is finding A's requirements.
      const removing = {
        ...mock,
        name: "mock",
        label: mock.label,
        readText: mock.readText.bind(mock),
        judgeImage: mock.judgeImage.bind(mock),
        transcribe: mock.transcribe.bind(mock),
        extractRequirements: async (input, signal) => {
          if (!removed) {
            removed = true;
            expect(await removeFile(state.db, fake.bucket, await session(), await fileId("brief B.txt"), new Date())).toEqual({ ok: true });
          }
          return mock.extractRequirements(input, signal);
        },
      } as AnalysisProvider;
      const { result, run } = await readOnce(state.db, removing);
      expect(result).toBe("cancelled");
      expect(run.failure_reason).toBe(BRIEF_FILES_CHANGED_MESSAGE);
      expect(await allRows()).toEqual(before.filter((r) => r.expected_value !== "sales@skybook.com")); // nothing new; B's are gone with B
      expect(await orphans()).toEqual([]);
      // What's uploaded now (A alone) was read successfully before B was added: Check Design uses A's only.
      expect(await used()).not.toContain("sales@skybook.com");
      expect(await used()).toContain("+971 4 123 4567");
      expect(await actions.markReadyAction({}, form({ sessionId }))).toMatchObject({ ok: true });
    });

    it("a file added during the reading: cancelled with the read-again message; Check Design and Try again wait until it's read", async () => {
      const mock = new MockProvider();
      let added = false;
      const adding = {
        ...mock,
        name: "mock",
        label: mock.label,
        readText: mock.readText.bind(mock),
        judgeImage: mock.judgeImage.bind(mock),
        transcribe: mock.transcribe.bind(mock),
        extractRequirements: async (input, signal) => {
          if (!added) {
            added = true;
            await upload("information", "brief C.txt", text("Website www.skybook.com"));
          }
          return mock.extractRequirements(input, signal);
        },
      } as AnalysisProvider;
      const { result, run } = await readOnce(state.db, adding);
      expect(result).toBe("cancelled");
      expect(run.failure_reason).toBe(BRIEF_FILES_CHANGED_MESSAGE);
      expect(await orphans()).toEqual([]);
      expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual({ error: READINESS_MESSAGES.briefNotRead });
      expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "content" }))).toEqual({ error: READINESS_MESSAGES.briefNotRead });
      expect(await designRuns()).toEqual([]);
      expect((await readOnce()).result).toBe("done");
      expect(await used()).toContain("www.skybook.com");
      expect(await actions.markReadyAction({}, form({ sessionId }))).toMatchObject({ ok: true });
    });

    it("a file removed just before the save locks the files: the save sees it, rolls back and cancels — no partial or orphaned requirements", async () => {
      await upload("information", "brief B.txt", text("Email sales@skybook.com"));
      const before = await allRows();
      const bId = await fileId("brief B.txt");
      // At the save's lock, B is already gone (a removal that committed a moment earlier).
      const db = intercept(state.db, async (sql, _params, run) => {
        const rows = await run();
        return sql.includes("for share") ? rows.filter((r) => (r as { id: string }).id !== bId) : rows;
      });
      const { result, run } = await readOnce(db);
      expect(result).toBe("cancelled");
      expect(run.failure_reason).toBe(BRIEF_FILES_CHANGED_MESSAGE);
      expect(await allRows()).toEqual(before); // rolled back: the clear and every insert undone
      expect(await orphans()).toEqual([]);
    });

    it("a save that fails part-way (an error after some requirements were inserted): everything rolled back, the reading failed", async () => {
      await upload("information", "brief B.txt", text("Email sales@skybook.com\nCall +971 4 999 0000"));
      const before = await allRows();
      let inserts = 0;
      const db = intercept(state.db, async (sql, _params, run) => {
        if (sql.includes("insert into qc_requirements") && ++inserts === 2) throw new Error("connection lost");
        return run();
      });
      const { result } = await readOnce(db);
      expect(result).toBe("failed");
      expect(inserts).toBe(2);
      expect(await allRows()).toEqual(before);
      expect(await orphans()).toEqual([]);
      expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual({ error: READINESS_MESSAGES.briefNotRead });
    });

    it("the save's lock order matches file removal (run claim → brief files → requirements), so the two can't deadlock", async () => {
      await upload("information", "brief B.txt", text("Email sales@skybook.com"));
      const seen: string[] = [];
      const db = intercept(state.db, async (sql, _params, run) => {
        seen.push(sql.replace(/\s+/g, " ").trim());
        return run();
      });
      expect((await readOnce(db)).result).toBe("done");
      const claim = seen.findIndex((q) => q.startsWith("select id from qc_analysis_runs") && q.endsWith("for update"));
      const files = seen.findIndex((q) => q.includes("from qc_files") && q.endsWith("for share"));
      const clear = seen.findIndex((q) => q.startsWith("delete from qc_requirements"));
      const insert = seen.findIndex((q) => q.startsWith("insert into qc_requirements"));
      expect(claim).toBeGreaterThanOrEqual(0);
      expect(claim).toBeLessThan(files);
      expect(files).toBeLessThan(clear); // the brief files are locked before any requirement is touched
      expect(clear).toBeLessThan(insert);
    });

    it("files changed at save time: cancelled before any requirement is touched (no delete or insert at all)", async () => {
      await upload("information", "brief B.txt", text("Email sales@skybook.com"));
      const bId = await fileId("brief B.txt");
      const seen: string[] = [];
      const db = intercept(state.db, async (sql, _params, run) => {
        seen.push(sql.replace(/\s+/g, " ").trim());
        const rows = await run();
        return sql.includes("for share") ? rows.filter((r) => (r as { id: string }).id !== bId) : rows;
      });
      expect((await readOnce(db)).result).toBe("cancelled");
      const afterLock = seen.slice(seen.findIndex((q) => q.endsWith("for share")));
      expect(afterLock.some((q) => q.startsWith("delete from qc_requirements") || q.startsWith("insert into qc_requirements"))).toBe(false);
    });

    it("removing a brief file locks it first (so a save in progress finishes before its requirements are removed)", async () => {
      const seen: string[] = [];
      const db = intercept(state.db, async (sql, _params, run) => {
        seen.push(sql.replace(/\s+/g, " ").trim().slice(0, 40));
        return run();
      });
      expect(await removeFile(db, fake.bucket, await session(), await fileId("brief A.txt"), new Date())).toEqual({ ok: true });
      const lock = seen.findIndex((s) => s.startsWith("select id from qc_files where id = $1"));
      const clear = seen.findIndex((s) => s.startsWith("delete from qc_requirements"));
      const drop = seen.findIndex((s) => s.startsWith("delete from qc_files"));
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(clear);
      expect(clear).toBeLessThan(drop);
      expect(await orphans()).toEqual([]);
      expect(await used()).toEqual([]);
    });

    it("a removal after the save: the file's requirements go with it — never orphaned", async () => {
      await upload("information", "brief B.txt", text("Email sales@skybook.com"));
      expect((await readOnce()).result).toBe("done");
      expect(await used()).toContain("sales@skybook.com");
      await actions.removeFileAction({}, form({ sessionId, fileId: await fileId("brief B.txt") }));
      expect(await used()).not.toContain("sales@skybook.com");
      expect(await orphans()).toEqual([]);
    });
  });
});
