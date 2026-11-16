import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import {
  analysisUsage,
  cancelAnalysisReservation,
  pruneAnalysisUsage,
  releaseAnalysisSlot,
  reserveAnalysis,
} from "@/lib/db/analysis-usage";
import { pruneLoginThrottle, recordAttempt } from "@/lib/db/login-throttle";

/** The per-user AI counts in their own table (migration 0012), and the hourly clean-up of old counters. */

const T0 = new Date("2026-11-16T09:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe("analysis_usage", () => {
  let db: Database;
  let close: () => Promise<void>;
  let dee: string;
  let sam: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDatabase());
    dee = (await insertTestUser(db, { name: "Dee", email: "dee@skybook.com", role: "designer" })).id;
    sam = (await insertTestUser(db, { name: "Sam", email: "sam@skybook.com", role: "designer" })).id;
  });
  beforeEach(() => db.exec("delete from analysis_usage; delete from login_throttle"));
  afterAll(() => close());

  it("a reservation counts for the day and holds a waiting place until its run is queued", async () => {
    const id = randomUUID();
    await reserveAnalysis(db, dee, id, T0);
    expect(await analysisUsage(db, dee, T0)).toEqual({ today: 1, oldest: T0, active: 1 });
    await releaseAnalysisSlot(db, dee, id);
    expect(await analysisUsage(db, dee, T0)).toEqual({ today: 1, oldest: T0, active: 0 });
  });

  it("a cancelled reservation isn't counted at all", async () => {
    const id = randomUUID();
    await reserveAnalysis(db, dee, id, T0);
    await cancelAnalysisReservation(db, dee, id);
    expect(await analysisUsage(db, dee, T0)).toEqual({ today: 0, oldest: null, active: 0 });
  });

  it("counts each user separately; one user can't release or cancel another's reservation", async () => {
    const id = randomUUID();
    await reserveAnalysis(db, dee, id, T0);
    await releaseAnalysisSlot(db, sam, id);
    await cancelAnalysisReservation(db, sam, id);
    expect(await analysisUsage(db, dee, T0)).toEqual({ today: 1, oldest: T0, active: 1 });
    expect(await analysisUsage(db, sam, T0)).toEqual({ today: 0, oldest: null, active: 0 });
  });

  it("a place left behind by a crash stops counting as waiting after 2 minutes, but still counts for the day", async () => {
    await reserveAnalysis(db, dee, randomUUID(), T0);
    expect((await analysisUsage(db, dee, at(1.9))).active).toBe(1);
    expect(await analysisUsage(db, dee, at(2.5))).toMatchObject({ today: 1, active: 0 });
  });

  it("counts the rolling 24 hours, with the oldest analysis in them", async () => {
    await reserveAnalysis(db, dee, randomUUID(), T0);
    await reserveAnalysis(db, dee, randomUUID(), at(60));
    expect(await analysisUsage(db, dee, at(24 * 60 - 1))).toMatchObject({ today: 2, oldest: T0 });
    expect(await analysisUsage(db, dee, at(24 * 60))).toMatchObject({ today: 1, oldest: at(60) });
  });

  it("a new reservation forgets that user's analyses older than 24 hours", async () => {
    await reserveAnalysis(db, dee, randomUUID(), T0);
    await reserveAnalysis(db, sam, randomUUID(), T0);
    await reserveAnalysis(db, dee, randomUUID(), at(24 * 60 + 1));
    const left = await db.query<{ user_id: string }>("select user_id from analysis_usage order by reserved_at");
    expect(left.map((r) => r.user_id)).toEqual([sam, dee]);
  });

  it("goes when the user is deleted", async () => {
    const ghost = (await insertTestUser(db, { name: "Gone", email: "gone@skybook.com", role: "designer" })).id;
    await reserveAnalysis(db, ghost, randomUUID(), T0);
    await db.query("delete from app_users where id = $1", [ghost]);
    expect(await db.query("select id from analysis_usage where user_id = $1", [ghost])).toEqual([]);
  });

  it("the hourly clean-up deletes every user's analyses older than 24 hours, and nothing newer", async () => {
    await reserveAnalysis(db, dee, randomUUID(), T0);
    await reserveAnalysis(db, sam, randomUUID(), at(10));
    await reserveAnalysis(db, sam, randomUUID(), at(24 * 60));
    expect(await pruneAnalysisUsage(db, at(24 * 60 + 5))).toBe(1);
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from analysis_usage"))[0].n)).toBe(2);
  });
});

describe("pruneLoginThrottle", () => {
  let db: Database;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDatabase()));
  afterAll(() => close());

  it("deletes counters idle for over a day (old sign-in, per-IP and pre-0012 AI rows) and keeps the rest", async () => {
    await recordAttempt(db, "email:old@skybook.com", T0, 900);
    await recordAttempt(db, "ip:203.0.113.7", T0, 900);
    await db.query("insert into login_throttle (key, attempts, window_started_at) values ('ai:u:r', 1, $1), ('ai-slot:u:r', 1, $1)", [T0]);
    await recordAttempt(db, "email:new@skybook.com", at(24 * 60 - 10), 900);
    expect(await pruneLoginThrottle(db, at(24 * 60 + 1))).toBe(4);
    expect((await db.query<{ key: string }>("select key from login_throttle")).map((r) => r.key)).toEqual(["email:new@skybook.com"]);
  });
});
