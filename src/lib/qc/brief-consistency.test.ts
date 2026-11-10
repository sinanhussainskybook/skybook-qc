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
 * Brief consistency (Stage 2): QC only ever uses requirements read from the brief files uploaded NOW,
 * plus manually entered ones. A successful reading replaces what earlier readings found; removing a brief
 * file removes what was read from it; a reading where any file fails isn't a success; and Check Design /
 * the design check's Try again wait until the current brief files have been read successfully.
 * Real (in-memory) PostgreSQL, the real brief reading (mock AI), the real server actions.
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
const { insertCompany } = await import("@/lib/db/companies");
const { findCurrentSession, insertRequirement, listFiles, listRequirements } = await import("@/lib/db/qc-sessions");
const { claimNextRun, latestRun } = await import("@/lib/db/analysis-runs");
const { processRun } = await import("@/lib/analysis/pipeline");
const { MockProvider } = await import("@/lib/analysis/mock-provider");
const { PassThroughPreparer } = await import("@/lib/analysis/media/types");
const { briefProblemsMessage } = await import("@/lib/analysis/information");
const { READINESS_MESSAGES } = await import("@/lib/qc/session");

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const text = (s: string) => new TextEncoder().encode(s);

describe("brief consistency: only the current brief files' requirements (plus manual ones)", () => {
  let close: () => Promise<void>;
  let dee: User;
  let acme: string;
  let sessionId: string;
  let fake: ReturnType<typeof createFakeBucket>;
  let tempRoot: string;
  let clock = 0;

  const values = async () => (await listRequirements(state.db, sessionId)).map((r) => r.expected_value).sort();
  const designRuns = () => state.db.query("select id from qc_analysis_runs where session_id = $1 and kind = 'content'", [sessionId]);
  const fileId = async (name: string) => (await listFiles(state.db, sessionId)).find((f) => f.file_name === name)!.id;

  async function upload(kind: "content" | "information", name: string, bytes: Uint8Array) {
    const prepared = await actions.prepareUploadAction({ sessionId, kind, name, size: bytes.length, type: "" });
    if (!prepared.ok) throw new Error(prepared.error);
    fake.browserPut(prepared.uploadUrl, bytes);
    const confirmed = await actions.confirmUploadAction({ sessionId, fileId: prepared.fileId });
    if (!confirmed.ok) throw new Error(confirmed.error);
    // Each queued reading a little later than the one before (as in real use), so "newest" is well defined.
    await state.db.query("update qc_analysis_runs set created_at = now() + make_interval(secs => $2) where session_id = $1 and status = 'queued'", [sessionId, ++clock]);
  }
  /**
   * The worker reads the brief: whatever is queued, else a new reading (Read again). A queued reading whose
   * files changed before it started is cancelled by the worker (as always); the designer then reads again.
   */
  async function readBrief(provider: AnalysisProvider = new MockProvider()) {
    for (;;) {
      if ((await latestRun(state.db, sessionId, "information"))?.status !== "queued") {
        expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "information" }))).toEqual({ ok: true });
        await state.db.query("update qc_analysis_runs set created_at = now() + make_interval(secs => $2) where session_id = $1 and status = 'queued'", [sessionId, ++clock]);
      }
      const run = (await claimNextRun(state.db, new Date(), "mock"))!;
      const result = await processRun({ db: state.db, storage: fake.bucket, logoStorage: null, provider, preparer: new PassThroughPreparer(), tempRoot, sleep: async () => {} }, run);
      if (result !== "cancelled") return { result, run: (await latestRun(state.db, sessionId, "information"))! };
    }
  }
  /** What brief A alone gives (the mock AI also proposes its first line). */
  let fromA: string[] = [];
  /** The mock AI, except that finding requirements fails for files named here. */
  const failingFor = (...names: string[]): AnalysisProvider => {
    const mock = new MockProvider();
    return {
      ...mock,
      name: "mock",
      label: mock.label,
      readText: mock.readText.bind(mock),
      judgeImage: mock.judgeImage.bind(mock),
      transcribe: mock.transcribe.bind(mock),
      extractRequirements: async (input, signal) => (names.includes(input.sourceName ?? "") ? "{ not json" : mock.extractRequirements(input, signal)),
    } as AnalysisProvider;
  };
  const checkDesign = () => actions.markReadyAction({}, form({ sessionId }));
  const tryAgain = () => actions.startAnalysisAction({}, form({ sessionId, kind: "content" }));

  beforeAll(async () => {
    const test = await createTestDatabase();
    state.db = test.db;
    close = test.close;
    dee = await insertTestUser(test.db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    acme = (await insertCompany(test.db, { name: "Acme", createdBy: dee.id })).id;
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "qc-brief-consistency-"));
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
    await upload("content", "post.png", PNG);
    // Brief A, read and its requirements confirmed by an earlier Check Design (the design then checked).
    await upload("information", "brief A.txt", text("Call +971 4 123 4567"));
    expect((await readBrief()).result).toBe("done");
    expect(await checkDesign()).toMatchObject({ ok: true });
    await state.db.query("delete from qc_analysis_runs where session_id = $1 and kind = 'content'", [sessionId]);
    expect((await listRequirements(state.db, sessionId)).filter((r) => r.confirmed).map((r) => r.expected_value)).toContain("+971 4 123 4567");
    fromA = await values();
  });

  it("replacing a brief: A's confirmed requirements go with A; only B's are used", async () => {
    await upload("information", "brief B.txt", text("Email sales@skybook.com"));
    expect(await actions.removeFileAction({}, form({ sessionId, fileId: await fileId("brief A.txt") }))).toEqual({ ok: true });
    expect(await values()).not.toContain("+971 4 123 4567"); // gone with its file, confirmed or not
    expect((await readBrief()).result).toBe("done");
    expect(await values()).toEqual(expect.arrayContaining(["sales@skybook.com"]));
    expect(await values()).not.toContain("+971 4 123 4567");
    expect(await checkDesign()).toMatchObject({ ok: true });
  });

  it("removing a brief without reading again: its requirements are gone, and Check Design / Try again wait for a reading", async () => {
    await upload("information", "brief B.txt", text("Email sales@skybook.com"));
    expect((await readBrief()).result).toBe("done");
    await actions.removeFileAction({}, form({ sessionId, fileId: await fileId("brief B.txt") }));
    expect(await values()).not.toContain("sales@skybook.com");
    expect(await values()).toContain("+971 4 123 4567"); // A is still uploaded: its requirement stays
    expect(await checkDesign()).toEqual({ error: READINESS_MESSAGES.briefNotRead });
    expect(await tryAgain()).toEqual({ error: READINESS_MESSAGES.briefNotRead });
    expect(await designRuns()).toEqual([]);
    expect((await readBrief()).result).toBe("done");
    expect(await checkDesign()).toMatchObject({ ok: true });
  });

  it("re-reading the same brief replaces, never accumulates: no duplicates, nothing stale", async () => {
    // A requirement read from a file that has since gone (left by older versions of the app: no source file).
    await state.db.query("insert into qc_requirements (session_id, type, expected_value, source, confirmed) values ($1, 'price', 'AED 1', 'extracted', true)", [sessionId]);
    const before = await values();
    expect((await readBrief()).result).toBe("done");
    expect(await values()).toEqual(before.filter((v) => v !== "AED 1"));
    expect((await readBrief()).result).toBe("done");
    expect(await values()).toEqual(before.filter((v) => v !== "AED 1"));
  });

  it("manually entered requirements are kept through removing, replacing and re-reading briefs", async () => {
    await insertRequirement(state.db, sessionId, { type: "offer", label: null, expected_value: "20% off", notes: null, mandatory: true, confirmed: true }, new Date());
    await upload("information", "brief B.txt", text("Email sales@skybook.com"));
    await actions.removeFileAction({}, form({ sessionId, fileId: await fileId("brief A.txt") }));
    expect((await readBrief()).result).toBe("done");
    expect((await readBrief()).result).toBe("done");
    const manual = (await listRequirements(state.db, sessionId)).filter((r) => r.source === "manual");
    expect(manual.map((r) => [r.expected_value, r.confirmed])).toEqual([["20% off", true]]);
  });

  it("a new reading that finds nothing: the old confirmed requirements are not used — Check Design asks for a clearer brief", async () => {
    await upload("information", "brief B.txt", text("   "));
    await actions.removeFileAction({}, form({ sessionId, fileId: await fileId("brief A.txt") }));
    expect((await readBrief()).result).toBe("done");
    expect(await values()).toEqual([]);
    expect(await checkDesign()).toEqual({ error: READINESS_MESSAGES.briefUnclear });
    expect(await tryAgain()).toEqual({ error: READINESS_MESSAGES.requirements });
    expect(await designRuns()).toEqual([]);
  });

  it("AI extraction fails for one file: the reading fails naming it, nothing is replaced, and the design waits", async () => {
    await upload("information", "brief B.txt", text("Email sales@skybook.com"));
    const { result, run } = await readBrief(failingFor("brief B.txt"));
    expect(result).toBe("failed");
    expect(run.failure_reason).toMatch(/^brief B\.txt: /);
    // Not replaced: still only what the last successful reading (of A alone) found — and B isn't read.
    expect(await values()).toEqual(fromA);
    expect(await checkDesign()).toEqual({ error: READINESS_MESSAGES.briefNotRead });
    expect(await tryAgain()).toEqual({ error: READINESS_MESSAGES.briefNotRead });
    expect(await designRuns()).toEqual([]);
    // Read again, and it works: both files' requirements, and the design can be checked.
    expect((await readBrief()).result).toBe("done");
    expect(await values()).toEqual(expect.arrayContaining(["+971 4 123 4567", "sales@skybook.com"]));
    expect(await checkDesign()).toMatchObject({ ok: true });
  });

  it("several files fail: all are named", async () => {
    await upload("information", "brief B.txt", text("Email sales@skybook.com"));
    const { result, run } = await readBrief(failingFor("brief A.txt", "brief B.txt"));
    expect(result).toBe("failed");
    expect(run.failure_reason).toMatch(/^2 brief files couldn't be read: brief A\.txt: .*; brief B\.txt: /);
  });

  it("a file that can't be read at all fails the reading too (before, another readable file let it finish)", async () => {
    await upload("information", "brief B.txt", text("Email sales@skybook.com"));
    // The stored file vanishes (e.g. Storage lost it): it can't be read.
    const b = (await listFiles(state.db, sessionId)).find((f) => f.file_name === "brief B.txt")!;
    fake.files.delete(b.storage_path);
    const { result, run } = await readBrief();
    expect(result).toBe("failed");
    expect(run.failure_reason).toBe("brief B.txt: the file couldn't be read from storage");
    expect(await checkDesign()).toEqual({ error: READINESS_MESSAGES.briefNotRead });
  });

  it("the same files read again but that reading fails: the last successful reading of THESE files still counts", async () => {
    const { result } = await readBrief(failingFor("brief A.txt"));
    expect(result).toBe("failed");
    expect(await values()).toEqual(fromA);
    expect(await checkDesign()).toMatchObject({ ok: true });
  });

  it("the message: one file as before; several within 300 characters", () => {
    expect(briefProblemsMessage(["a.pdf: the PDF couldn't be read"])).toBe("a.pdf: the PDF couldn't be read");
    const long = briefProblemsMessage(Array.from({ length: 10 }, (_, i) => `brief ${i}.docx: ${"x".repeat(60)}`));
    expect(long.length).toBe(300);
    expect(long.startsWith("10 brief files couldn't be read: brief 0.docx: ")).toBe(true);
  });
});
