import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeBucket } from "../../../test/fake-storage";
import { pngOf } from "../../../test/media-samples";
import type { Database } from "@/lib/db/database";
import type { User } from "@/lib/db/users";
import { insertCompany } from "@/lib/db/companies";
import { insertPendingFile, insertSession, markFileReady, NO_PLATFORM, setSessionPlatform, type QcSession } from "@/lib/db/qc-sessions";
import { cancelRun, claimNextRun, failRun, findRun, finishRun, heartbeat, insertRun, latestDetections } from "@/lib/db/analysis-runs";
import { MockProvider } from "@/lib/analysis/mock-provider";
import { PassThroughPreparer } from "@/lib/analysis/media/types";
import { LocalMediaPreparer } from "@/lib/analysis/media/local";
import { runFfmpeg } from "@/lib/analysis/media/video";
import { readFile } from "node:fs/promises";
import type { AnalysisProvider } from "@/lib/analysis/provider";
import sharp from "sharp";
import { filesFingerprint, processRun, type RunDeps } from "@/lib/analysis/pipeline";
import { recoverStale, sweepTempRoot, workOnce } from "@/lib/analysis/worker";
import { listFiles } from "@/lib/db/qc-sessions";

/** Plan 6.10 — runs end to end on the mock, with a real (in-memory) PostgreSQL and a fake Storage. */
describe("analysis runs (mock provider)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let dee: User;
  let sam: User;
  let acme: string;
  let session: QcSession;
  let fake: ReturnType<typeof createFakeBucket>;
  let tempRoot: string;
  const T0 = new Date("2026-10-04T09:00:00Z");
  const clock = { now: T0 };
  const deps = (): RunDeps => ({
    db,
    storage: fake.bucket,
    logoStorage: null,
    provider: new MockProvider(),
    preparer: new PassThroughPreparer(),
    tempRoot,
    now: () => clock.now,
    sleep: async () => {},
  });

  async function addContent(name: string, bytes = pngOf(1080, 1350)) {
    const id = crypto.randomUUID();
    const storagePath = `${session.id}/${id}.png`;
    await insertPendingFile(db, session.id, { id, kind: "content", fileName: name, storagePath, mimeType: "image/png", fileSize: bytes.length }, clock.now);
    await markFileReady(db, session.id, id, bytes.length, clock.now, { width: 1080, height: 1350 });
    fake.files.set(storagePath, bytes);
    return id;
  }
  async function queue(userId = dee.id) {
    const files = (await listFiles(db, session.id, "ready")).filter((f) => f.kind === "content");
    return (await insertRun(db, { sessionId: session.id, userId, kind: "content", provider: "mock", fingerprint: filesFingerprint(files) }, clock.now))!;
  }
  async function claimAndProcess() {
    const run = (await claimNextRun(db, clock.now, "mock"))!;
    return { result: await processRun(deps(), run), run: (await findRun(db, run.id))! };
  }

  beforeAll(async () => {
    const test = await createTestDatabase();
    db = test.db;
    close = test.close;
    dee = await insertTestUser(db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    sam = await insertTestUser(db, { name: "Sam", email: "sam@skybook.com", role: "designer" });
    acme = (await insertCompany(db, { name: "Acme", createdBy: dee.id })).id;
  });
  afterAll(() => close());
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    clock.now = T0;
    fake = createFakeBucket();
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "qc-runs-test-"));
    await db.query("delete from qc_sessions");
    session = (await insertSession(db, { companyId: acme, userId: dee.id, contentType: "social_post" }, T0))!;
    await setSessionPlatform(db, session.id, { ...NO_PLATFORM, platform: "instagram", placement: "feed_image" }, T0);
  });

  it("mock end-to-end: queued → processing → done, with ONE labelled ContentDetections", async () => {
    await addContent("poster.png");
    const queued = await queue();
    expect(queued.status).toBe("queued");
    const { result, run } = await claimAndProcess();
    expect(result).toBe("done");
    expect(run).toMatchObject({ status: "done", attempts: 1, progress_done: run.progress_total, stage: "Finished" });
    const stored = (await latestDetections(db, session.id))!;
    expect(stored.provider).toBe("mock");
    expect(stored.detections.source).toBe("mock");
    expect(stored.detections.texts?.map((t) => [t.text, t.role ?? null])).toEqual([
      ["Sample data — not real AI", "other"],
      ["Sample headline", "headline"],
      ["Book now", "cta"],
    ]);
    expect(stored.detections.textCoverage).toBe(0.95);
    expect(existsSync(path.join(tempRoot, run.id))).toBe(false); // temporary folder removed
  });

  it("with the real local preparer: image prepared locally, colours MEASURED from pixels into the detections", async () => {
    const png = new Uint8Array(await sharp({ create: { width: 1000, height: 1250, channels: 3, background: "#ffffff" } }).png().toBuffer());
    await addContent("poster.png", png);
    await queue();
    const run = (await claimNextRun(db, clock.now, "mock"))!;
    expect(await processRun({ ...deps(), preparer: new LocalMediaPreparer() }, run)).toBe("done");
    const d = (await latestDetections(db, session.id))!.detections;
    expect(d.colors?.[0]).toMatchObject({ hex: "#FFFFFF" });
    expect(d.frame).toEqual({ width: 1000, height: 1250 });
  });

  it("video end to end (real FFmpeg + mock): frames read, same text merged into one timed span, speech and measured audio", async () => {
    const out = path.join(tempRoot, "reel.mp4");
    const made = await runFfmpeg(
      ["-f", "lavfi", "-i", "color=c=white:s=320x568:d=3:r=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-map", "0", "-map", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out],
      new AbortController().signal
    );
    expect(made.code).toBe(0);
    const bytes = new Uint8Array(await readFile(out));
    await db.query("update qc_sessions set content_type = 'reel_short' where id = $1", [session.id]);
    const id = crypto.randomUUID();
    const storagePath = `${session.id}/${id}.mp4`;
    await insertPendingFile(db, session.id, { id, kind: "content", fileName: "reel.mp4", storagePath, mimeType: "video/mp4", fileSize: bytes.length }, clock.now);
    await markFileReady(db, session.id, id, bytes.length, clock.now, { width: 320, height: 568, durationMs: 3000 });
    fake.files.set(storagePath, bytes);
    await queue();
    const sent: string[] = [];
    const mock = new MockProvider();
    const watching: AnalysisProvider = {
      name: mock.name,
      label: mock.label,
      readText: (img, sig) => (sent.push(img.mime), mock.readText(img, sig)),
      judgeImage: (input, sig) => mock.judgeImage(input, sig),
      transcribe: (input, sig) => (sent.push(input.mime), mock.transcribe(input, sig)),
      extractRequirements: (input, sig) => mock.extractRequirements(input, sig),
    };
    const run = (await claimNextRun(db, clock.now, "mock"))!;
    expect(await processRun({ ...deps(), provider: watching, preparer: new LocalMediaPreparer() }, run)).toBe("done");
    expect(sent.every((m) => m.startsWith("image/") || m === "audio/mp3")).toBe(true); // never the original video
    const d = (await latestDetections(db, session.id))!.detections;
    // A static white video: one frame after duplicate removal, so each mock text is one span covering the video.
    expect(d.texts?.filter((t) => t.text === "Sample headline").map((t) => [t.startMs, t.endMs])).toEqual([[0, 3000]]);
    expect(d.speech).toEqual([{ text: "Sample speech — not real AI", startMs: 0, endMs: 2000, confidence: 0.7 }]);
    expect(d.audio).toMatchObject({ hasAudio: true, confidence: 1 });
    expect(d.audio?.integratedLufs).toBeLessThan(0);
  }, 60_000);

  it("only one active run per session", async () => {
    await addContent("poster.png");
    await queue();
    const files = await listFiles(db, session.id, "ready");
    expect(await insertRun(db, { sessionId: session.id, userId: dee.id, kind: "content", provider: "mock", fingerprint: filesFingerprint(files) }, T0)).toBeNull();
  });

  it("a provider failure fails the run with a plain reason; nothing is stored", async () => {
    await addContent("x-mock-fail.png");
    await queue();
    const { result, run } = await claimAndProcess();
    expect(result).toBe("failed");
    // The designer sees a plain message; the provider's own text stays in the server log.
    expect(run.failure_reason).toBe("Analysis isn't set up correctly — tell your admin.");
    expect(vi.mocked(console.error).mock.calls.some((c) => String(c[0]).includes("Sample failure (mock provider)."))).toBe(true);
    expect(await latestDetections(db, session.id)).toBeNull();
  });

  it("a temporary failure is retried and succeeds", async () => {
    await addContent("x-mock-retry.png");
    await queue();
    expect((await claimAndProcess()).result).toBe("done");
  });

  it("an invalid AI response keeps the OCR text but no AI labels (those checks stay not verified)", async () => {
    await addContent("x-mock-malformed.png");
    await queue();
    expect((await claimAndProcess()).result).toBe("done");
    const d = (await latestDetections(db, session.id))!.detections;
    expect(d.texts?.length).toBe(3);
    expect(d.texts?.some((t) => t.role)).toBe(false);
    expect(d.fonts).toBeUndefined();
    expect(d.logo).toBeUndefined();
  });

  it("files changed after queueing → cancelled, not a stale result", async () => {
    await addContent("a.png");
    await queue();
    await addContent("b.png");
    const { result, run } = await claimAndProcess();
    expect(result).toBe("cancelled");
    expect(run.failure_reason).toMatch(/files changed/);
  });

  it("the worker re-checks access: membership removed, session expired, or not the owner → cancelled", async () => {
    await addContent("poster.png");
    // Not the session's owner (a forged request by another designer).
    await insertRun(db, { sessionId: session.id, userId: sam.id, kind: "content", provider: "mock", fingerprint: "x:1" }, T0);
    expect((await claimAndProcess()).result).toBe("cancelled");

    // Expired.
    await queue();
    clock.now = new Date(T0.getTime() + 25 * 3_600_000);
    expect((await claimAndProcess()).result).toBe("cancelled");
    clock.now = T0;

    // Membership removed (Dee is the creator; remove the membership row).
    await queue();
    await db.query("delete from company_members where company_id = $1 and user_id = $2", [acme, dee.id]);
    try {
      expect((await claimAndProcess()).result).toBe("cancelled");
    } finally {
      await db.query("insert into company_members (company_id, user_id) values ($1, $2)", [acme, dee.id]);
    }
  });

  it("only the newest finished run keeps detections", async () => {
    await addContent("poster.png");
    await queue();
    const first = await claimAndProcess();
    clock.now = new Date(T0.getTime() + 60_000);
    await queue();
    const second = await claimAndProcess();
    expect([first.result, second.result]).toEqual(["done", "done"]);
    const rows = await db.query<{ id: string; has: boolean }>("select id, detections is not null as has from qc_analysis_runs where session_id = $1", [session.id]);
    expect(rows.find((r) => r.id === first.run.id)?.has).toBe(false);
    expect(rows.find((r) => r.id === second.run.id)?.has).toBe(true);
  });

  it("stale runs are queued again, then failed after their attempts", async () => {
    await addContent("poster.png");
    await queue();
    const run = (await claimNextRun(db, T0, "mock"))!;
    clock.now = new Date(T0.getTime() + 3 * 60_000);
    expect(await recoverStale({ db, now: () => clock.now })).toEqual({ requeued: 1, failed: 0 });
    expect((await findRun(db, run.id))!.status).toBe("queued");
    await db.query("update qc_analysis_runs set status = 'processing', attempts = 3, heartbeat_at = $2 where id = $1", [run.id, T0]);
    expect(await recoverStale({ db, now: () => clock.now })).toEqual({ requeued: 0, failed: 1 });
    expect((await findRun(db, run.id))!).toMatchObject({ status: "failed", failure_reason: "The analysis stopped responding." });
  });

  it("a cancelled run can't be overwritten by a slow worker", async () => {
    await addContent("poster.png");
    await queue();
    const run = (await claimNextRun(db, T0, "mock"))!;
    await db.query("update qc_analysis_runs set status = 'cancelled' where id = $1", [run.id]);
    expect(await heartbeat(db, run, T0)).toBe(false);
    expect(await processRun(deps(), run)).toBe("lost");
  });

  describe("regression: a paused worker can't touch its run once it was recovered (claims are tied to their attempt)", () => {
    const afterStall = () => new Date(T0.getTime() + 3 * 60_000); // > 2 min without a heartbeat → stale

    it("claimed again: the old claim's heartbeat, finish, fail and cancel all change nothing; the new claim works", async () => {
      await addContent("poster.png");
      await queue();
      const paused = (await claimNextRun(db, T0, "mock"))!; // attempt 1 — this worker then stalls
      clock.now = afterStall();
      expect(await recoverStale({ db, now: () => clock.now })).toEqual({ requeued: 1, failed: 0 });
      const current = (await claimNextRun(db, clock.now, "mock"))!; // attempt 2
      expect(current.id).toBe(paused.id);
      expect(current.attempts).toBe(paused.attempts + 1);

      expect(await heartbeat(db, paused, clock.now)).toBe(false);
      expect(await finishRun(db, paused, { analysedShare: 1 }, clock.now)).toBe(false);
      expect(await failRun(db, paused, "stale worker", clock.now)).toBe(false);
      expect(await cancelRun(db, paused, "stale worker", clock.now)).toBe(false);
      expect(await findRun(db, paused.id)).toMatchObject({ status: "processing", attempts: current.attempts, failure_reason: null });

      // The paused worker resuming does no work and writes nothing…
      const provider = new MockProvider();
      const judged = vi.spyOn(provider, "judgeImage");
      const read = vi.spyOn(provider, "readText");
      expect(await processRun({ ...deps(), provider }, paused)).toBe("lost");
      expect(judged).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(await latestDetections(db, session.id)).toBeNull();
      expect(await findRun(db, paused.id)).toMatchObject({ status: "processing", attempts: current.attempts });

      // …and the current claim finishes normally.
      expect(await processRun(deps(), current)).toBe("done");
      expect(await findRun(db, current.id)).toMatchObject({ status: "done", attempts: 2 });
      expect(await latestDetections(db, session.id)).not.toBeNull();
    });

    it("put back in the queue (not yet claimed again): the paused worker can't fail or cancel it — the retry is kept", async () => {
      await addContent("poster.png");
      await queue();
      const paused = (await claimNextRun(db, T0, "mock"))!;
      clock.now = afterStall();
      await recoverStale({ db, now: () => clock.now });
      expect(await failRun(db, paused, "stale worker", clock.now)).toBe(false);
      expect(await cancelRun(db, paused, "stale worker", clock.now)).toBe(false);
      expect(await heartbeat(db, paused, clock.now)).toBe(false);
      expect(await findRun(db, paused.id)).toMatchObject({ status: "queued", failure_reason: null });
      expect(await processRun(deps(), paused)).toBe("lost");
      expect((await findRun(db, paused.id))!.status).toBe("queued");
    });
  });

  it("workOnce claims the oldest queued run; an empty queue does nothing", async () => {
    expect(await workOnce(deps())).toBe(false);
    await addContent("poster.png");
    await queue();
    expect(await workOnce(deps())).toBe(true);
  });

  it("a worker claims only runs for ITS provider — cross-provider runs are never taken", async () => {
    // One queued run per provider (one active run per session, so one session each).
    const runFor = async (provider: "gemini" | "mock" | "google" | "local", companyName: string) => {
      const companyId = companyName === "Acme" ? acme : (await insertCompany(db, { name: companyName, createdBy: dee.id })).id;
      const s = companyId === acme ? session : (await insertSession(db, { companyId, userId: dee.id, contentType: "social_post" }, T0))!;
      return (await insertRun(db, { sessionId: s.id, userId: dee.id, kind: "content", provider, fingerprint: "x:1" }, T0))!;
    };
    const gemini = await runFor("gemini", "Acme");
    const mock = await runFor("mock", "Beta");
    const google = await runFor("google", "Gamma");
    const local = await runFor("local", "Delta");

    // A mock worker gets the mock run — and then nothing, although three other runs are queued.
    expect((await claimNextRun(db, T0, "mock"))?.id).toBe(mock.id);
    expect(await claimNextRun(db, T0, "mock")).toBeNull();
    for (const other of [gemini, google, local]) expect(await findRun(db, other.id)).toMatchObject({ status: "queued", attempts: 0, started_at: null });

    // Each provider's worker gets exactly its own run.
    expect((await claimNextRun(db, T0, "google"))?.id).toBe(google.id);
    expect((await claimNextRun(db, T0, "gemini"))?.id).toBe(gemini.id);
    expect((await claimNextRun(db, T0, "local"))?.id).toBe(local.id);
    for (const provider of ["gemini", "mock", "google", "local"] as const) expect(await claimNextRun(db, T0, provider)).toBeNull();
    await db.query("delete from companies where name in ('Beta', 'Gamma', 'Delta')");
  });

  it("workOnce with a mock worker leaves a Gemini run untouched (not claimed, not processed)", async () => {
    await addContent("poster.png");
    const files = (await listFiles(db, session.id, "ready")).filter((f) => f.kind === "content");
    const run = (await insertRun(db, { sessionId: session.id, userId: dee.id, kind: "content", provider: "gemini", fingerprint: filesFingerprint(files) }, T0))!;
    const mock = new MockProvider();
    const read = vi.spyOn(mock, "readText");
    const judge = vi.spyOn(mock, "judgeImage");
    expect(await workOnce({ ...deps(), provider: mock })).toBe(false); // nothing for a mock worker
    expect(read).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(await findRun(db, run.id)).toMatchObject({ status: "queued", attempts: 0, provider: "gemini", started_at: null });
    expect(await latestDetections(db, session.id)).toBeNull(); // no results stored for the session
    // Still there for a Gemini worker.
    expect((await claimNextRun(db, T0, "gemini"))?.id).toBe(run.id);
  });

  it("sweeps leftover temporary folders at start", async () => {
    await mkdir(path.join(tempRoot, "old-run"), { recursive: true });
    await writeFile(path.join(tempRoot, "old-run", "frame.png"), "x");
    expect(await sweepTempRoot(tempRoot)).toBe(1);
    expect(await readdir(tempRoot)).toEqual([]);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("runs are deleted with their session (no history)", async () => {
    await addContent("poster.png");
    await queue();
    await db.query("delete from qc_sessions where id = $1", [session.id]);
    expect(await db.query("select 1 from qc_analysis_runs")).toEqual([]);
  });
});
