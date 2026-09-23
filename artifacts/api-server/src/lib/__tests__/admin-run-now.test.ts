import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Drives the admin SMS and Instagram manual "Run now" endpoints and the
// settings bootstrap path through the real Express app + DB. Neither feed
// polls on a timer any more, so these buttons are the only way to pull
// new messages/posts on demand:
//
//   1. POST .../poller/run-now (both feeds) calls the one-shot runner.
//   2. PUT against a missing singleton row still inserts the row.
//
// Both feeds share the singleton `event_settings` row, and the missing-
// singleton tests delete + re-insert that row. Vitest can interleave
// tests across files within the same singleFork pool, so consolidating
// SMS + IG coverage into one file keeps the bootstrap-insert assertions
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
import * as igPoller from "../instagramPoller";

const runSmsPollOnceMock = smsScheduler.runSmsPollOnce as unknown as ReturnType<
  typeof vi.fn
>;
const runPollerOnceMock = igPoller.runPollerOnce as unknown as ReturnType<
  typeof vi.fn
>;
const auth = `Bearer ${generateAdminToken()}`;

// Snapshot of the singleton row state we'll restore at the end so other
// suites running in the same fork (sms-inbox-forward-gates, etc.) see the world they expect.
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

describe("POST /api/admin/sms-settings/poller/run-now", () => {
  it("succeeds (200) and runs one poll", async () => {
    await ensureSingletonExists();

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
  it("inserts the singleton row", async () => {
    await db.delete(eventSettingsTable).where(eq(eventSettingsTable.id, 1));

    await request(app)
      .put("/api/admin/sms-settings")
      .set("Authorization", auth)
      .send({ ownerNotificationPhone: "5555550199" })
      .expect(200);

    const [row] = await db
      .select()
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    expect(row).toBeDefined();
  });
});

// ── Instagram ─────────────────────────────────────────────────────────────────

describe("POST /api/admin/instagram/poller/run-now", () => {
  it("succeeds (200) and runs one poll", async () => {
    await ensureSingletonExists();

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
  it("inserts the singleton row", async () => {
    await db.delete(eventSettingsTable).where(eq(eventSettingsTable.id, 1));

    await request(app)
      .put("/api/admin/instagram/settings")
      .set("Authorization", auth)
      .send({ instagramHandle: "runnowtest" })
      .expect(200);

    const [row] = await db
      .select()
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    expect(row).toBeDefined();
    expect(row?.instagramHandle).toBe("runnowtest");
  });
});
