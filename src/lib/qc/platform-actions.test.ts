import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeBucket } from "../../../test/fake-storage";
import { EXE } from "../../../test/logo-files";
import { jpegOf, mp4Of, pngOf } from "../../../test/media-samples";
import type { Database } from "@/lib/db/database";
import type { User } from "@/lib/db/users";
import type { BucketClient } from "@/lib/storage/storage-api";

/**
 * Phase 5 through the server actions, with a real (in-memory) PostgreSQL and
 * a fake Storage: the platform choice (tests A, F, G) and measuring uploaded
 * content for the Platform / Size check.
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
const { findCurrentSession, listFiles } = await import("@/lib/db/qc-sessions");
const { runRules } = await import("@/lib/qc/engine");
const { PLATFORM_RULES, platformContextOf } = await import("@/lib/qc/rules/platform-size");

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

describe("Phase 5 — platform choice and measured content", () => {
  let close: () => Promise<void>;
  let dee: User;
  let sam: User;
  let acme: string;
  let fake: ReturnType<typeof createFakeBucket>;
  let sessionId: string;

  const sessionOf = async (user: User) => findCurrentSession(state.db, acme, user.id, new Date());

  async function upload(name: string, bytes: Uint8Array, type = "") {
    const prepared = await actions.prepareUploadAction({ sessionId, kind: "content", name, size: bytes.length, type });
    if (!prepared.ok) throw new Error(prepared.error);
    fake.browserPut(prepared.uploadUrl, bytes);
    return actions.confirmUploadAction({ sessionId, fileId: prepared.fileId });
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
  afterAll(() => close());
  beforeEach(async () => {
    fake = createFakeBucket();
    state.storage = fake.bucket;
    state.user = dee;
    await state.db.query("delete from qc_sessions");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await actions.startSessionAction({}, form({ companyId: acme, contentType: "social_post" }));
    sessionId = (await sessionOf(dee))!.id;
  });

  describe("A / F. choosing a platform and keeping it", () => {
    it("a valid choice is saved and is still there on the next load", async () => {
      expect(await actions.setPlatformAction({}, form({ sessionId, platform: "linkedin", placement: "image_square" }))).toEqual({
        ok: true,
        message: "Platform saved.",
      });
      expect(await sessionOf(dee)).toMatchObject({ platform: "linkedin", placement: "image_square", custom_width: null });
    });

    it("Other keeps its description and typed size", async () => {
      await actions.setPlatformAction(
        {},
        form({ sessionId, platform: "other", customLabel: "Airport screen", customWidth: "1920", customHeight: "1080", customUnit: "px", customMaxMb: "2" })
      );
      expect(await sessionOf(dee)).toMatchObject({
        platform: "other",
        placement: null,
        custom_label: "Airport screen",
        custom_width: 1920,
        custom_height: 1080,
        custom_unit: "px",
        custom_max_bytes: 2_000_000,
      });
    });

    it("an invalid choice is refused and the saved one is kept", async () => {
      await actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "feed_image" }));
      const invalid: Record<string, string>[] = [
        { platform: "tiktok" },
        { platform: "instagram", placement: "reels" }, // a video placement for an image check
        { platform: "youtube", placement: "video" },
        { platform: "other", customWidth: "10", customHeight: "10", customUnit: "px" }, // no description
        { platform: "instagram", placement: "feed_image'; drop table qc_sessions; --" },
      ];
      for (const bad of invalid) {
        expect(await actions.setPlatformAction({}, form({ sessionId, ...bad })), JSON.stringify(bad)).toMatchObject({ error: expect.any(String) });
      }
      expect(await sessionOf(dee)).toMatchObject({ platform: "instagram", placement: "feed_image" });
    });

    it("changing between image and video content clears the platform; image to image keeps it", async () => {
      await actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "feed_image" }));
      await actions.changeContentTypeAction({}, form({ sessionId, contentType: "design_poster" }));
      expect((await sessionOf(dee))!.platform).toBe("instagram");
      // Video types aren't offered any more: the action refuses them and nothing changes.
      expect(await actions.changeContentTypeAction({}, form({ sessionId, contentType: "reel_short" }))).toEqual({ error: "Choose what you're checking." });
      expect((await sessionOf(dee))!.platform).toBe("instagram");
      // The kept session logic still clears the platform for a video type (for when video returns).
      const { changeContentType } = await import("@/lib/qc/session");
      expect(await changeContentType(state.db, (await sessionOf(dee))!, "reel_short", new Date())).toMatchObject({ ok: true });
      expect(await sessionOf(dee)).toMatchObject({ platform: null, placement: null });
    });

    it("saving a platform sets a Ready session back to draft and restarts the 24 hours", async () => {
      await state.db.query("update qc_sessions set status = 'ready', expires_at = now() + interval '1 hour'");
      await actions.setPlatformAction({}, form({ sessionId, platform: "facebook", placement: "feed_image" }));
      const session = (await sessionOf(dee))!;
      expect(session.status).toBe("draft");
      expect(session.expires_at.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    });

    it("the database itself refuses a placement without a platform or half a custom size", async () => {
      await expect(state.db.query("update qc_sessions set placement = 'feed_image' where id = $1", [sessionId])).rejects.toThrow();
      await expect(state.db.query("update qc_sessions set platform = 'other', custom_width = 10 where id = $1", [sessionId])).rejects.toThrow();
      await expect(state.db.query("update qc_sessions set platform = 'Bad Key' where id = $1", [sessionId])).rejects.toThrow();
    });
  });

  describe("F / G. ownership and expiry", () => {
    it("another designer can't set the platform on Dee's session; nothing changes", async () => {
      state.user = sam;
      expect(await actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "feed_image" }))).toMatchObject({
        error: expect.stringMatching(/isn't available/),
      });
      state.user = dee;
      expect((await sessionOf(dee))!.platform).toBeNull();
    });

    it("forged IDs and an expired session are refused", async () => {
      for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid", ""]) {
        expect(await actions.setPlatformAction({}, form({ sessionId: id, platform: "instagram", placement: "feed_image" }))).toMatchObject({
          error: expect.any(String),
        });
      }
      await state.db.query("update qc_sessions set expires_at = now() - interval '1 minute'");
      expect(await actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "feed_image" }))).toMatchObject({
        error: expect.stringMatching(/isn't available/),
      });
      const [row] = await state.db.query<{ platform: string | null }>("select platform from qc_sessions where id = $1", [sessionId]);
      expect(row.platform).toBeNull();
    });

    it("signed out: sent to sign-in", async () => {
      state.user = null;
      await expect(actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "feed_image" }))).rejects.toThrow(
        "NEXT_REDIRECT /login"
      );
    });
  });

  describe("measuring uploaded content", () => {
    it("an image's size is measured on upload and checked against the platform", async () => {
      await actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "stories_image" }));
      expect(await upload("story.png", pngOf(1080, 1350))).toEqual({ ok: true });
      const [file] = await listFiles(state.db, sessionId);
      expect(file).toMatchObject({ media_width: 1080, media_height: 1350, media_note: null });

      const findings = runRules(PLATFORM_RULES, "social_post", platformContextOf((await sessionOf(dee))!, await listFiles(state.db, sessionId)));
      expect(findings.find((f) => f.ruleId === "platform.ratio")).toMatchObject({ status: "failed", severity: "major" });
      expect(findings.find((f) => f.ruleId === "platform.format")).toMatchObject({ status: "passed" });
    });

    it("a sideways phone photo is measured upright", async () => {
      expect(await upload("photo.jpg", jpegOf(1920, 1080, { orientation: 6 }))).toEqual({ ok: true });
      expect((await listFiles(state.db, sessionId))[0]).toMatchObject({ media_width: 1080, media_height: 1920 });
    });

    it("a video whose details sit after the first 64 KB is read in full to measure it", async () => {
      // Video sessions can't be started from the UI now; the measuring code is kept and tested.
      await state.db.query("update qc_sessions set content_type = 'reel_short' where id = $1", [sessionId]);
      const video = mp4Of(1080, 1920, 15_000, { moovAtEnd: true, mdatBytes: 100_000 });
      expect(await upload("reel.mp4", video)).toEqual({ ok: true });
      expect((await listFiles(state.db, sessionId))[0]).toMatchObject({
        media_width: 1080,
        media_height: 1920,
        media_duration_ms: 15_000,
        file_size: video.length,
      });
    });

    it("C. a disguised file is still rejected before anything is measured", async () => {
      expect(await upload("poster.png", EXE)).toMatchObject({ ok: false });
      expect(await listFiles(state.db, sessionId, "any")).toEqual([]);
    });

    it("Ready needs a platform (or an exact size in the brief)", async () => {
      await upload("post.png", pngOf(1440, 1800));
      await actions.saveRequirementAction({}, form({ sessionId, type: "price", expected_value: "AED 99", mandatory: "on" }));
      expect(await actions.markReadyAction({}, form({ sessionId }))).toEqual({ error: expect.stringMatching(/^Choose the platform the design is for/) });
      await actions.setPlatformAction({}, form({ sessionId, platform: "instagram", placement: "feed_image" }));
      expect(await actions.markReadyAction({}, form({ sessionId }))).toMatchObject({ ok: true });
    });
  });
});
