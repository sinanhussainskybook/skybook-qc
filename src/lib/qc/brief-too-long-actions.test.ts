import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeBucket } from "../../../test/fake-storage";
import { PNG } from "../../../test/logo-files";
import type { Database } from "@/lib/db/database";
import type { User } from "@/lib/db/users";
import type { BucketClient } from "@/lib/storage/storage-api";

/**
 * Stage 2 safeguard: while the newest brief reading found a brief too long for Local AI, neither Check
 * Design nor the design check's Try again can check the design — not even against requirements
 * confirmed in an earlier reading. Allowed again only once the brief has been read again successfully.
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
const { insertCompany } = await import("@/lib/db/companies");
const { findCurrentSession, insertRequirement, listFiles, listRequirements } = await import("@/lib/db/qc-sessions");
const { insertRun } = await import("@/lib/db/analysis-runs");
const { filesFingerprint, SAFE_REASONS } = await import("@/lib/analysis/pipeline");
const { oversizedBriefMessage } = await import("@/lib/qc/brief-length");

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const TOO_LONG = oversizedBriefMessage([{ name: "long brief.txt", chars: 15_000 }], 12_000);

describe("brief too long for Local AI: Check Design and Try again", () => {
  let close: () => Promise<void>;
  let dee: User;
  let acme: string;
  let sessionId: string;
  let fake: ReturnType<typeof createFakeBucket>;
  let clock = 0;

  const designRuns = () => state.db.query<{ status: string }>("select status from qc_analysis_runs where session_id = $1 and kind = 'content'", [sessionId]);

  async function upload(kind: "content" | "information", name: string, bytes: Uint8Array) {
    const prepared = await actions.prepareUploadAction({ sessionId, kind, name, size: bytes.length, type: "" });
    if (!prepared.ok) throw new Error(prepared.error);
    fake.browserPut(prepared.uploadUrl, bytes);
    await actions.confirmUploadAction({ sessionId, fileId: prepared.fileId });
  }
  /** A finished brief reading (newest), as the worker leaves it. */
  async function briefReading(status: "done" | "failed" | "cancelled", reason: string | null = null) {
    await state.db.query("delete from qc_analysis_runs where session_id = $1 and status in ('queued', 'processing')", [sessionId]);
    const files = (await listFiles(state.db, sessionId)).filter((f) => f.kind === "information");
    const run = await insertRun(state.db, { sessionId, userId: dee.id, kind: "information", provider: "mock", fingerprint: filesFingerprint(files) }, new Date(Date.now() + ++clock * 1000));
    await state.db.query("update qc_analysis_runs set status = $2, failure_reason = $3, finished_at = now() where id = $1", [run!.id, status, reason]);
  }

  beforeAll(async () => {
    const test = await createTestDatabase();
    state.db = test.db;
    close = test.close;
    dee = await insertTestUser(test.db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    acme = (await insertCompany(test.db, { name: "Acme", createdBy: dee.id })).id;
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
    sessionId = (await findCurrentSession(state.db, acme, dee.id, new Date()))!.id;
    // An earlier, successful reading: its requirement confirmed. Then a long brief added, and the newest reading stopped.
    await upload("information", "short brief.txt", new TextEncoder().encode("Call 0123 456 789"));
    await upload("content", "post.png", PNG);
    await briefReading("done");
    await insertRequirement(state.db, sessionId, { type: "phone", label: null, expected_value: "0123 456 789", notes: null, mandatory: true, confirmed: true }, new Date());
    expect((await listRequirements(state.db, sessionId)).some((r) => r.confirmed)).toBe(true);
    await upload("information", "long brief.txt", new TextEncoder().encode("x".repeat(15_000)));
    await briefReading("failed", TOO_LONG);
    await state.db.query("delete from qc_analysis_runs where session_id = $1 and kind = 'content'", [sessionId]);
  });

  it("Check Design is refused with the brief-too-long message — no design check queued", async () => {
    expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual({ error: TOO_LONG });
    expect(await designRuns()).toEqual([]);
  });

  it("Try again (the design check) is refused with the same message, even with requirements confirmed earlier", async () => {
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "content" }))).toEqual({ error: TOO_LONG });
    expect(await actions.startAnalysisAction({}, form({ sessionId }))).toEqual({ error: TOO_LONG }); // content is the default
    expect(await designRuns()).toEqual([]);
  });

  it("removing the long file isn't enough: both stay refused until the brief is read again", async () => {
    const long = (await listFiles(state.db, sessionId)).find((f) => f.file_name === "long brief.txt")!;
    expect(await actions.removeFileAction({}, form({ sessionId, fileId: long.id }))).toEqual({ ok: true });
    expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual({ error: TOO_LONG });
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "content" }))).toEqual({ error: TOO_LONG });
    // Read again (the brief) is allowed — it is how the brief gets read again.
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "information" }))).toEqual({ ok: true });
    expect(await designRuns()).toEqual([]);
  });

  // A newer brief reading that doesn't finish successfully never lifts the hold — whatever the reason.
  for (const [what, status, reason] of [
    ["times out", "failed", SAFE_REASONS.stopped],
    ["fails for another reason", "failed", "short brief.txt: the file couldn't be read from storage"],
    ["fails without a reason", "failed", null],
    ["is cancelled (files changed)", "cancelled", SAFE_REASONS.changed],
    ["is cancelled (session unavailable)", "cancelled", SAFE_REASONS.unavailable],
  ] as const) {
    it(`a newer reading that ${what}: Check Design and Try again stay refused with the same message; Read again stays allowed`, async () => {
      const long = (await listFiles(state.db, sessionId)).find((f) => f.file_name === "long brief.txt")!;
      await actions.removeFileAction({}, form({ sessionId, fileId: long.id }));
      await briefReading(status, reason);
      expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual({ error: TOO_LONG });
      expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "content" }))).toEqual({ error: TOO_LONG });
      expect(await designRuns()).toEqual([]);
      expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "information" }))).toEqual({ ok: true });
    });
  }

  it("a newer reading still waiting or running (incomplete): both stay refused", async () => {
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "information" }))).toEqual({ ok: true }); // queued
    // (This test's earlier readings are dated a little ahead: make the queued one the newest, as it is in real use.)
    await state.db.query("update qc_analysis_runs set created_at = now() + interval '1 hour' where session_id = $1 and status = 'queued'", [sessionId]);
    // Both give the same answer (one rule for both): the brief is still being read.
    const reading = { error: "The brief is still being read — this takes a few seconds." };
    expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual(reading);
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "content" }))).toEqual(reading);
    await state.db.query("update qc_analysis_runs set status = 'processing' where session_id = $1 and status = 'queued'", [sessionId]);
    expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual(reading);
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "content" }))).toEqual(reading);
    expect(await designRuns()).toEqual([]);
  });

  it("several unsuccessful readings in a row, then one that finishes: lifted only by the one that finishes", async () => {
    const long = (await listFiles(state.db, sessionId)).find((f) => f.file_name === "long brief.txt")!;
    await actions.removeFileAction({}, form({ sessionId, fileId: long.id }));
    await briefReading("failed", SAFE_REASONS.stopped);
    await briefReading("cancelled", SAFE_REASONS.changed);
    await briefReading("failed", "short brief.txt: the file couldn't be read from storage");
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "content" }))).toEqual({ error: TOO_LONG });
    await briefReading("done");
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "content" }))).toEqual({ ok: true });
  });

  it("a new too-long result after a successful reading holds again", async () => {
    await briefReading("done");
    await briefReading("failed", TOO_LONG);
    expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual({ error: TOO_LONG });
  });

  it("once the brief has been read again successfully: Check Design and Try again work again", async () => {
    const long = (await listFiles(state.db, sessionId)).find((f) => f.file_name === "long brief.txt")!;
    await actions.removeFileAction({}, form({ sessionId, fileId: long.id }));
    await briefReading("done");
    expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual({ ok: true, message: "Checking the design…" });
    expect(await designRuns()).toEqual([{ status: "queued" }]);
    await state.db.query("update qc_analysis_runs set status = 'failed', failure_reason = 'Gemini is busy' where session_id = $1 and kind = 'content'", [sessionId]);
    expect(await actions.startAnalysisAction({}, form({ sessionId, kind: "content" }))).toEqual({ ok: true });
  });
});
