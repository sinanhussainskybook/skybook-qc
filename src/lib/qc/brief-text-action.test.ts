import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeBucket } from "../../../test/fake-storage";
import type { Database } from "@/lib/db/database";
import type { User } from "@/lib/db/users";
import type { BucketClient } from "@/lib/storage/storage-api";

/** Enter brief text (Stage 2): the server action — who may use it, what it saves, and the brief reading it starts. */

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
const { findCurrentSession, listFiles } = await import("@/lib/db/qc-sessions");
const { BRIEF_TEXT_MESSAGES } = await import("@/lib/qc/brief-text");

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

describe("saveBriefTextAction", () => {
  let close: () => Promise<void>;
  let dee: User;
  let sam: User;
  let acme: string;
  let sessionId: string;
  let fake: ReturnType<typeof createFakeBucket>;
  const runs = () =>
    state.db.query<{ kind: string; status: string }>("select kind, status from qc_analysis_runs where session_id = $1", [sessionId]);

  beforeAll(async () => {
    const test = await createTestDatabase();
    state.db = test.db;
    close = test.close;
    dee = await insertTestUser(test.db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    sam = await insertTestUser(test.db, { name: "Sam", email: "sam@skybook.com", role: "designer" });
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
    vi.spyOn(console, "error").mockImplementation(() => {});
    await actions.startSessionAction({}, form({ companyId: acme, contentType: "social_post" }));
    sessionId = (await findCurrentSession(state.db, acme, dee.id, new Date()))!.id;
  });

  it("saves the text as a brief file and starts reading it straight away, as an upload does", async () => {
    expect(await actions.saveBriefTextAction({}, form({ sessionId, briefText: "Headline: Summer Sale\nCall 0123 456 789" }))).toEqual({
      ok: true,
      message: "Saved as Typed brief.txt — the brief is being read now.",
    });
    const [file] = await listFiles(state.db, sessionId);
    expect(file).toMatchObject({ kind: "information", file_name: "Typed brief.txt", mime_type: "text/plain", status: "ready" });
    expect(new TextDecoder().decode(fake.files.get(file.storage_path))).toBe("Headline: Summer Sale\nCall 0123 456 789\n");
    expect(await runs()).toEqual([{ kind: "information", status: "queued" }]);
  });

  it("with an uploaded brief too: the waiting reading takes in both", async () => {
    const bytes = new TextEncoder().encode("Email sales@skybook.com");
    const prepared = await actions.prepareUploadAction({ sessionId, kind: "information", name: "notes.txt", size: bytes.length, type: "text/plain" });
    if (!prepared.ok) throw new Error(prepared.error);
    fake.browserPut(prepared.uploadUrl, bytes);
    expect(await actions.confirmUploadAction({ sessionId, fileId: prepared.fileId })).toEqual({ ok: true });
    expect(await actions.saveBriefTextAction({}, form({ sessionId, briefText: "Call 0123 456 789" }))).toMatchObject({ ok: true });
    expect((await listFiles(state.db, sessionId)).map((f) => f.file_name).sort()).toEqual(["Typed brief.txt", "notes.txt"]);
    expect(await runs()).toEqual([{ kind: "information", status: "queued" }]); // one reading, for both
  });

  it("empty or too long: the message, nothing saved, no reading started", async () => {
    expect(await actions.saveBriefTextAction({}, form({ sessionId, briefText: "  \n " }))).toEqual({ error: BRIEF_TEXT_MESSAGES.empty });
    expect(await actions.saveBriefTextAction({}, form({ sessionId }))).toEqual({ error: BRIEF_TEXT_MESSAGES.empty });
    expect(await actions.saveBriefTextAction({}, form({ sessionId, briefText: "x".repeat(20_001) }))).toEqual({ error: BRIEF_TEXT_MESSAGES.tooLong(20_001) });
    expect(await listFiles(state.db, sessionId, "any")).toEqual([]);
    expect(fake.files.size).toBe(0);
    expect(await runs()).toEqual([]);
  });

  it("Local AI on this server: text it couldn't read in full is refused (nothing saved); within 12,000 it's saved", async () => {
    process.env.QC_ANALYSIS_PROVIDER = "local";
    try {
      expect(await actions.saveBriefTextAction({}, form({ sessionId, briefText: "x".repeat(12_001) }))).toEqual({
        error: BRIEF_TEXT_MESSAGES.beyondReading(12_001, 12_000),
      });
      expect(await listFiles(state.db, sessionId, "any")).toEqual([]);
      expect(fake.files.size).toBe(0);
      expect(await actions.saveBriefTextAction({}, form({ sessionId, briefText: "x".repeat(12_000) }))).toMatchObject({ ok: true });
      expect((await listFiles(state.db, sessionId)).map((f) => f.file_size)).toEqual([12_001]); // the text and its final line break
    } finally {
      process.env.QC_ANALYSIS_PROVIDER = "mock";
    }
  });

  it("only the session's own designer; never without storage; a forged session id changes nothing", async () => {
    state.user = sam;
    expect(await actions.saveBriefTextAction({}, form({ sessionId, briefText: "Headline: Sale" }))).toEqual({
      error: "This QC session isn't available any more. Reload the page.",
    });
    state.user = dee;
    expect(await actions.saveBriefTextAction({}, form({ sessionId: "not-a-uuid", briefText: "Headline: Sale" }))).toMatchObject({ error: expect.any(String) });
    state.storage = null;
    expect(await actions.saveBriefTextAction({}, form({ sessionId, briefText: "Headline: Sale" }))).toEqual({
      error: "File storage isn't set up on this server yet. Ask your administrator.",
    });
    expect(await listFiles(state.db, sessionId, "any")).toEqual([]);
    state.user = null;
    await expect(actions.saveBriefTextAction({}, form({ sessionId, briefText: "Headline: Sale" }))).rejects.toThrow("NEXT_REDIRECT /login");
  });
});
