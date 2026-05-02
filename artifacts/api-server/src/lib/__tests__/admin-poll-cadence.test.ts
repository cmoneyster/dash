import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Drives the admin SMS-settings and Instagram-settings PUT/Run-now
// endpoints through the real Express app + DB to lock down the new
// operator-tunable poll cadence (task #212):
//
//   1. PUT /admin/sms-settings persists smsPollEnabled +
//      smsPollIntervalSeconds; PUT /admin/instagram/settings persists
//      instagramPollEnabled + instagramPollIntervalMinutes.
//   2. Out-of-range interval values are rejected with 400 before they
//      ever reach the DB.
//   3. POST .../poller/run-now (both feeds) succeeds even when the
//      persisted enabled flag is false — the manual button is the
//      whole point of the operator-disable knob.
//   4. PUT against a missing singleton row inserts a row with the new
//      poll-cadence columns populated, both when the caller sends them
//      and when the bootstrap PUT omits them entirely.
//
// Both feeds share the singleton `event_settings` row, and the missing-
// singleton tests delete + re-insert that row. Vitest can interleave
// tests across files within the same singleFork pool, so consolidating
// SMS + IG coverage into one file makes the bootstrap-insert assertions
// race-free against each other.

vi.mock("../sms-scheduler", async () => {
  const actual = await vi.importActual<typeof import("../sms-scheduler")>(
    "../sms-scheduler",
  );
  return {
    ...actual,
    runSmsPollOnce: vi.fn(async () => ({
      ranAt: new Date().toISOString(),
      skipped: false as const,
      port: 7,
      fetchedCount: 0,
      ingested: 0,
      errors: 0,
    })),
  };
});

vi.mock("../instagramPoller", async () => {
  const actual = await vi.importActual<typeof import("../instagramPoller")>(
    "../instagramPoller",
  );
  return {
    ...actual,
    runPollerOnce: vi.fn(async () => ({
      ranAt: new Date().toISOString(),
      hashtags: [],
      apiCalls: 0,
      inserted: 0,
      skipped: 0,
      errors: [],
      notConfigured: true,
    })),
  };
});

import { db } from "@workspace/db";
import { eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import app from "../../app";
import { generateAdminToken } from "../adminAuth";
import * as smsScheduler from "../sms-scheduler";
import { SMS_POLL_INTERVAL_RANGE } from "../sms-scheduler";
import * as igPoller from "../instagramPoller";
import { INSTAGRAM_POLL_INTERVAL_RANGE } from "../instagramPoller";

const runSmsPollOnceMock = smsScheduler.runSmsPollOnce as unknown as ReturnType<
  typeof vi.fn
>;
const runPollerOnceMock = igPoller.runPollerOnce as unknown as ReturnType<
  typeof vi.fn
>;
const auth = `Bearer ${generateAdminToken()}`;

// Snapshot of the singleton row state we'll restore at the end so other
// suites running in the same fork (cart-order-pricing,
// sms-inbox-forward-gates, etc.) see the world they expect.
let originalSettings: typeof eventSettingsTable.$inferSelect | null = null;

async function ensureSingletonExists(): Promise<void> {
  const [row] = await db
    .select()
    .from(eventSettingsTable)
    .where(eq(eventSettingsTable.id, 1));
  if (!row) {
    await db.insert(eventSettingsTable).values({ id: 1 });
  }
}

async function restoreSingleton(): Promise<void> {
  if (!originalSettings) return;
  // Replace the row wholesale from the snapshot so any unrelated columns
  // (otdSetupFee, eventName, etc.) are also restored — not just the
  // SMS/IG-facing ones this suite touches. Otherwise a follow-on suite
  // running in the same singleFork pool could observe partially mutated
  // state on the singleton row.
  await db.delete(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
  await db.insert(eventSettingsTable).values(originalSettings);
}

beforeAll(async () => {
  await ensureSingletonExists();
  const [row] = await db
    .select()
    .from(eventSettingsTable)
    .where(eq(eventSettingsTable.id, 1));
  originalSettings = row ?? null;
});

afterAll(async () => {
  await restoreSingleton();
});

beforeEach(() => {
  runSmsPollOnceMock.mockClear();
  runPollerOnceMock.mockClear();
});

// ── SMS ───────────────────────────────────────────────────────────────────────

describe("PUT /api/admin/sms-settings — poll cadence persistence", () => {
  it("persists smsPollEnabled and smsPollIntervalSeconds", async () => {
    await ensureSingletonExists();

    const res = await request(app)
      .put("/api/admin/sms-settings")
      .set("Authorization", auth)
      .send({ smsPollEnabled: false, smsPollIntervalSeconds: 60 })
      .expect(200);

    expect(res.body.smsPollEnabled).toBe(false);
    expect(res.body.smsPollIntervalSeconds).toBe(60);

    const [row] = await db
      .select()
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    expect(row?.smsPollEnabled).toBe(false);
    expect(row?.smsPollIntervalSeconds).toBe(60);
  });

  it("rejects smsPollIntervalSeconds below the min (2)", async () => {
    await ensureSingletonExists();

    const res = await request(app)
      .put("/api/admin/sms-settings")
      .set("Authorization", auth)
      .send({ smsPollIntervalSeconds: SMS_POLL_INTERVAL_RANGE.min - 1 })
      .expect(400);
    expect(res.body.error).toMatch(/smsPollIntervalSeconds/);
  });

  it("rejects smsPollIntervalSeconds above the max (601)", async () => {
    await ensureSingletonExists();

    const res = await request(app)
      .put("/api/admin/sms-settings")
      .set("Authorization", auth)
      .send({ smsPollIntervalSeconds: SMS_POLL_INTERVAL_RANGE.max + 1 })
      .expect(400);
    expect(res.body.error).toMatch(/smsPollIntervalSeconds/);
  });

  it("rejects non-integer smsPollIntervalSeconds", async () => {
    await ensureSingletonExists();

    const res = await request(app)
      .put("/api/admin/sms-settings")
      .set("Authorization", auth)
      .send({ smsPollIntervalSeconds: 4.5 })
      .expect(400);
    expect(res.body.error).toMatch(/smsPollIntervalSeconds/);
  });
});

describe("POST /api/admin/sms-settings/poller/run-now", () => {
  it("succeeds (200) and runs the poll even when smsPollEnabled is false", async () => {
    await ensureSingletonExists();
    await db
      .update(eventSettingsTable)
      .set({ smsPollEnabled: false })
      .where(eq(eventSettingsTable.id, 1));

    const res = await request(app)
      .post("/api/admin/sms-settings/poller/run-now")
      .set("Authorization", auth)
      .expect(200);

    expect(runSmsPollOnceMock).toHaveBeenCalledTimes(1);
    expect(res.body).toHaveProperty("ranAt");
    expect(res.body).toHaveProperty("skipped", false);
  });
});

describe("PUT /api/admin/sms-settings — bootstrap insert when singleton row is missing", () => {
  it("inserts a row with the new poll-cadence fields populated", async () => {
    await db.delete(eventSettingsTable).where(eq(eventSettingsTable.id, 1));

    const res = await request(app)
      .put("/api/admin/sms-settings")
      .set("Authorization", auth)
      .send({ smsPollEnabled: false, smsPollIntervalSeconds: 45 })
      .expect(200);

    expect(res.body.smsPollEnabled).toBe(false);
    expect(res.body.smsPollIntervalSeconds).toBe(45);

    const [row] = await db
      .select()
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    expect(row).toBeDefined();
    expect(row?.smsPollEnabled).toBe(false);
    expect(row?.smsPollIntervalSeconds).toBe(45);
  });

  it("inserts a row with sensible defaults when the bootstrap PUT omits the poll fields", async () => {
    // Even when the caller's PUT doesn't touch the poll columns, the
    // bootstrap insert path must still populate them so the row is
    // self-consistent (matches the defensive comment in the route).
    await db.delete(eventSettingsTable).where(eq(eventSettingsTable.id, 1));

    const res = await request(app)
      .put("/api/admin/sms-settings")
      .set("Authorization", auth)
      .send({ ownerNotificationPhone: "5555550199" })
      .expect(200);

    expect(res.body.smsPollEnabled).toBe(true);
    expect(res.body.smsPollIntervalSeconds).toBe(
      SMS_POLL_INTERVAL_RANGE.default,
    );

    const [row] = await db
      .select()
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    expect(row?.smsPollEnabled).toBe(true);
    expect(row?.smsPollIntervalSeconds).toBe(SMS_POLL_INTERVAL_RANGE.default);
  });
});

// ── Instagram ─────────────────────────────────────────────────────────────────

describe("PUT /api/admin/instagram/settings — poll cadence persistence", () => {
  it("persists instagramPollEnabled and instagramPollIntervalMinutes", async () => {
    await ensureSingletonExists();

    await request(app)
      .put("/api/admin/instagram/settings")
      .set("Authorization", auth)
      .send({ instagramPollEnabled: false, instagramPollIntervalMinutes: 60 })
      .expect(200);

    const [row] = await db
      .select()
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    expect(row?.instagramPollEnabled).toBe(false);
    expect(row?.instagramPollIntervalMinutes).toBe(60);

    // Verify the moderation-page status echo also reflects the saved values.
    const status = await request(app)
      .get("/api/admin/instagram/status")
      .set("Authorization", auth)
      .expect(200);
    expect(status.body.instagramPollEnabled).toBe(false);
    expect(status.body.instagramPollIntervalMinutes).toBe(60);
  });

  it("rejects instagramPollIntervalMinutes below the min", async () => {
    await ensureSingletonExists();

    const res = await request(app)
      .put("/api/admin/instagram/settings")
      .set("Authorization", auth)
      .send({
        instagramPollIntervalMinutes: INSTAGRAM_POLL_INTERVAL_RANGE.min - 1,
      })
      .expect(400);
    expect(res.body.error).toMatch(/instagramPollIntervalMinutes/);
  });

  it("rejects instagramPollIntervalMinutes above the max", async () => {
    await ensureSingletonExists();

    const res = await request(app)
      .put("/api/admin/instagram/settings")
      .set("Authorization", auth)
      .send({
        instagramPollIntervalMinutes: INSTAGRAM_POLL_INTERVAL_RANGE.max + 1,
      })
      .expect(400);
    expect(res.body.error).toMatch(/instagramPollIntervalMinutes/);
  });

  it("rejects non-integer instagramPollIntervalMinutes", async () => {
    await ensureSingletonExists();

    const res = await request(app)
      .put("/api/admin/instagram/settings")
      .set("Authorization", auth)
      .send({ instagramPollIntervalMinutes: 7.5 })
      .expect(400);
    expect(res.body.error).toMatch(/instagramPollIntervalMinutes/);
  });
});

describe("POST /api/admin/instagram/poller/run-now", () => {
  it("succeeds (200) and runs the poll even when instagramPollEnabled is false", async () => {
    await ensureSingletonExists();
    await db
      .update(eventSettingsTable)
      .set({ instagramPollEnabled: false })
      .where(eq(eventSettingsTable.id, 1));

    const res = await request(app)
      .post("/api/admin/instagram/poller/run-now")
      .set("Authorization", auth)
      .expect(200);

    expect(runPollerOnceMock).toHaveBeenCalledTimes(1);
    expect(res.body).toHaveProperty("summary");
    expect(res.body).toHaveProperty("configured");
  });
});

describe("PUT /api/admin/instagram/settings — bootstrap insert when singleton row is missing", () => {
  it("inserts a row with the new poll-cadence fields populated", async () => {
    await db.delete(eventSettingsTable).where(eq(eventSettingsTable.id, 1));

    await request(app)
      .put("/api/admin/instagram/settings")
      .set("Authorization", auth)
      .send({ instagramPollEnabled: false, instagramPollIntervalMinutes: 90 })
      .expect(200);

    const [row] = await db
      .select()
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    expect(row).toBeDefined();
    expect(row?.instagramPollEnabled).toBe(false);
    expect(row?.instagramPollIntervalMinutes).toBe(90);
  });

  it("inserts a row with sensible defaults when the bootstrap PUT omits the poll fields", async () => {
    await db.delete(eventSettingsTable).where(eq(eventSettingsTable.id, 1));

    await request(app)
      .put("/api/admin/instagram/settings")
      .set("Authorization", auth)
      .send({ instagramHandle: "task212test" })
      .expect(200);

    const [row] = await db
      .select()
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    expect(row).toBeDefined();
    expect(row?.instagramPollEnabled).toBe(true);
    expect(row?.instagramPollIntervalMinutes).toBe(
      INSTAGRAM_POLL_INTERVAL_RANGE.default,
    );
  });
});
