import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { cateringInquiriesTable, menuItemsTable } from "@workspace/db/schema";
import { requireAdminAuth } from "../../lib/adminAuth";
import { sendMail, sendQuoteResponseAlert } from "../../lib/mail";
import { createAndPublishInvoiceForInquiry } from "../../lib/square";

vi.mock("../../lib/mail", () => ({
  sendQuoteResponseAlert: vi.fn().mockResolvedValue(undefined),
  sendMail: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../lib/sms", () => ({
  sendQuoteResponseSms: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/sms-inbox", () => ({
  sendToCustomerGuarded: vi.fn().mockResolvedValue({ status: "sent" }),
}));
vi.mock("../../lib/sms-ejoin", () => ({
  getSmsOutboundMode: vi.fn().mockReturnValue("shadow"),
}));
vi.mock("../../lib/square", () => ({
  SquareApiError: class SquareApiError extends Error {},
  isSquareConfigured: vi.fn().mockReturnValue(true),
  createAndPublishInvoiceForInquiry: vi.fn(),
  createAndPublishSupplementalInvoice: vi.fn(),
  cancelInvoice: vi.fn(),
  getInvoiceSnapshot: vi.fn(),
}));

import revisionRouter from "../catering-plan-revisions";
import adminCateringRouter from "../admin-catering";

const testApp = express();
testApp.use(express.json());
testApp.use("/api", adminCateringRouter);
testApp.use("/api", revisionRouter);
const securedApp = express();
securedApp.use(express.json());
securedApp.use("/api/admin/catering", requireAdminAuth);
securedApp.use("/api", revisionRouter);

let createdId: number | undefined;
afterEach(async () => {
  if (createdId) {
    await db.delete(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, createdId));
    createdId = undefined;
  }
  vi.clearAllMocks();
});

describe("inquiry-linked plan revision lifecycle", () => {
  it("links an existing inquiry, keeps submissions idempotent, merges staff lines, and invalidates an issued quote", async () => {
    const [menu] = await db.select().from(menuItemsTable).where(eq(menuItemsTable.available, true)).limit(1);
    expect(menu).toBeDefined();
    const sizeSlot = menu.pricingTemplate === "pan_sizes" ? 1 : null;
    // Choose the first configured pan size rather than assuming slot 1 exists.
    const firstSize = menu.pricingTemplate === "pan_sizes"
      ? [menu.size1Price, menu.size2Price, menu.size3Price, menu.size4Price, menu.size5Price]
        .findIndex(price => price != null)
      : -1;
    const selectedSize = firstSize >= 0 ? firstSize + 1 : sizeSlot;
    const quoteToken = crypto.randomUUID();
    const [inquiry] = await db.insert(cateringInquiriesTable).values({
      clientName: "Revision Test Inquiry",
      clientPhone: "5550100000",
      clientEmail: "revision-test@example.invalid",
      status: "quoted",
      guestCount: 20,
      quoteToken,
      quoteIssuedAt: new Date(),
      lineItems: [
        { id: "test-menu", menuItemId: menu.id, name: menu.name, quantity: Math.max(1, menu.minimumOrderQty ?? 1), unitPrice: 1, sizeSlot: selectedSize, priceMode: "manual" },
        { id: "test-custom", menuItemId: null, name: "Staff-only setup", quantity: 1, unitPrice: 25, priceMode: "manual" },
      ],
      fees: [{ id: "test-fee", label: "Delivery", kind: "fixed", amount: 10 }],
      discounts: [{ id: "test-discount", label: "Courtesy", kind: "fixed", amount: 5 }],
    }).returning();
    createdId = inquiry.id;

    const created = await request(testApp).post(`/api/admin/catering/${inquiry.id}/plan-link`).send({ channel: "copy" }).expect(200);
    const token = new URL(created.body.url as string).pathname.split("/").pop();
    await request(securedApp).get(`/api/admin/catering/${inquiry.id}/plan-revisions`).expect(401);
    await request(securedApp).post(`/api/admin/catering/${inquiry.id}/plan-link`).send({ channel: "copy" }).expect(401);
    await request(testApp).post(`/api/admin/catering/${inquiry.id}/plan-link`).send({ channel: "sms" }).expect(503);
    // A failed delivery request must not rotate the customer's working link.
    const opened = await request(testApp).get(`/api/plan/revise/${token}`).expect(200);
    expect(opened.body.items[0].unitPrice).not.toBe(1); // staff's manual price stays private
    expect(opened.body.pending).toBe(false);

    const submission = {
      version: opened.body.version,
      submissionId: crypto.randomUUID(),
      items: [{ menuItemId: menu.id, quantity: Math.max(1, menu.minimumOrderQty ?? 1), sizeSlot: selectedSize }],
      eventDate: null, eventTime: null, guestCount: 35, venueAddress: null, menuNotes: "No peanuts", note: "35 guests now",
    };
    const first = await request(testApp).post(`/api/plan/revise/${token}`).send(submission).expect(200);
    const retry = await request(testApp).post(`/api/plan/revise/${token}`).send(submission).expect(200);
    expect(retry.body.revisionId).toBe(first.body.revisionId);
    expect(sendQuoteResponseAlert).toHaveBeenCalledTimes(1);
    await request(testApp).post(`/api/plan/revise/${token}`)
      .send({ ...submission, submissionId: crypto.randomUUID() }).expect(409);
    const history = await request(testApp).get(`/api/admin/catering/${inquiry.id}/plan-revisions`).expect(200);
    expect(history.body.revisions).toHaveLength(1);
    expect(history.body.revisions[0].base.guestCount).toBe(20);
    expect(history.body.revisions[0].proposed.guestCount).toBe(35);

    await request(testApp).post(`/api/admin/catering/${inquiry.id}/plan-revisions/${first.body.revisionId}/review`)
      .send({ action: "apply" }).expect(200);
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
    const [updated] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, inquiry.id));
    expect(updated.guestCount).toBe(35);
    expect(updated.lineItems?.find(line => line.id === "test-custom")?.unitPrice).toBe(25);
    expect(updated.lineItems?.find(line => line.id === "test-menu")?.unitPrice).toBe(1);
    expect(updated.fees).toEqual(inquiry.fees);
    expect(updated.discounts).toEqual(inquiry.discounts);
    expect(updated.quoteToken).toBeNull();
    expect(updated.quoteIssuedAt).toBeNull();
    await request(testApp).post(`/api/admin/catering/${inquiry.id}/plan-revisions/${first.body.revisionId}/review`)
      .send({ action: "apply" }).expect(409);
    expect(sendMail).toHaveBeenCalledTimes(1);
    await request(testApp).delete(`/api/admin/catering/${inquiry.id}/plan-link`).expect(200);
    await request(testApp).get(`/api/plan/revise/${token}`).expect(404);
  });

  it("detects staff edits before applying, and closes access after invoicing", async () => {
    const [inquiry] = await db.insert(cateringInquiriesTable).values({
      clientName: "Revision Conflict Test",
      status: "inquiry",
      guestCount: 10,
    }).returning();
    createdId = inquiry.id;
    const created = await request(testApp).post(`/api/admin/catering/${inquiry.id}/plan-link`).send({ channel: "copy" }).expect(200);
    const token = new URL(created.body.url as string).pathname.split("/").pop();
    const opened = await request(testApp).get(`/api/plan/revise/${token}`).expect(200);
    const submission = {
      version: opened.body.version, submissionId: crypto.randomUUID(), items: [],
      eventDate: null, eventTime: null, guestCount: 15, venueAddress: null, menuNotes: null, note: "",
    };
    await db.update(cateringInquiriesTable).set({ guestCount: 11 }).where(eq(cateringInquiriesTable.id, inquiry.id));
    await request(testApp).post(`/api/plan/revise/${token}`).send(submission).expect(409);
    const latest = await request(testApp).get(`/api/plan/revise/${token}`).expect(200);
    const proposal = await request(testApp).post(`/api/plan/revise/${token}`)
      .send({ ...submission, version: latest.body.version }).expect(200);
    await db.update(cateringInquiriesTable).set({ guestCount: 12 }).where(eq(cateringInquiriesTable.id, inquiry.id));
    await request(testApp).post(`/api/admin/catering/${inquiry.id}/plan-revisions/${proposal.body.revisionId}/review`)
      .send({ action: "apply" }).expect(409);
    await db.update(cateringInquiriesTable).set({ squareInvoiceId: "test-invoice" }).where(eq(cateringInquiriesTable.id, inquiry.id));
    await request(testApp).get(`/api/plan/revise/${token}`).expect(410);
    await request(testApp).post(`/api/admin/catering/${inquiry.id}/plan-revisions/${proposal.body.revisionId}/review`)
      .send({ action: "apply" }).expect(409);
    const [staleCopy] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, inquiry.id));
    await request(testApp).put(`/api/admin/catering/${inquiry.id}`)
      .send({ updatedAt: staleCopy.updatedAt.toISOString(), menuNotes: "new staff edit" }).expect(200);
    await request(testApp).put(`/api/admin/catering/${inquiry.id}`)
      .send({ updatedAt: staleCopy.updatedAt.toISOString(), menuNotes: "stale edit" }).expect(409);
    const [stillCurrent] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, inquiry.id));
    expect(stillCurrent.menuNotes).toBe("new staff edit");
  });

  it("cannot apply a pending revision while Square is publishing an invoice for the old plan", async () => {
    const [inquiry] = await db.insert(cateringInquiriesTable).values({
      clientName: "Invoice Race Test",
      clientEmail: "invoice-race@example.invalid",
      status: "quoted",
      guestCount: 10,
      total: "50.00",
    }).returning();
    createdId = inquiry.id;
    const link = await request(testApp).post(`/api/admin/catering/${inquiry.id}/plan-link`).send({ channel: "copy" }).expect(200);
    const token = new URL(link.body.url as string).pathname.split("/").pop();
    const plan = await request(testApp).get(`/api/plan/revise/${token}`).expect(200);
    const proposal = await request(testApp).post(`/api/plan/revise/${token}`).send({
      version: plan.body.version, submissionId: crypto.randomUUID(), items: [],
      eventDate: null, eventTime: null, guestCount: 30, venueAddress: null, menuNotes: null, note: "",
    }).expect(200);

    let completePublish!: (value: {
      invoiceId: string; invoiceVersion: number; orderId: string;
      customerId: string; status: string; hostedUrl: string;
      balanceDueCents: number; balanceDueDate: string;
    }) => void;
    vi.mocked(createAndPublishInvoiceForInquiry).mockImplementationOnce(
      () => new Promise(resolve => { completePublish = resolve; }),
    );
    const invoiceRequest = request(testApp).post(`/api/admin/catering/${inquiry.id}/square/invoice`).send({});
    const invoicePromise = invoiceRequest.then(response => response);
    await vi.waitFor(() => expect(createAndPublishInvoiceForInquiry).toHaveBeenCalledTimes(1));
    const reviewPromise = request(testApp)
      .post(`/api/admin/catering/${inquiry.id}/plan-revisions/${proposal.body.revisionId}/review`)
      .send({ action: "apply" }).then(response => response);
    completePublish({
      invoiceId: "test-race-invoice", invoiceVersion: 1, orderId: "test-order",
      customerId: "test-customer", status: "UNPAID", hostedUrl: "https://example.invalid",
      balanceDueCents: 5000, balanceDueDate: "2026-12-01",
    });
    const [invoiced, reviewed] = await Promise.all([invoicePromise, reviewPromise]);
    expect(invoiced.status).toBe(200);
    expect(reviewed.status).toBe(409);
    const [current] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, inquiry.id));
    expect(current.guestCount).toBe(10);
    expect(current.squareInvoiceId).toBe("test-race-invoice");
  });
});