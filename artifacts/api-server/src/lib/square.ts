// Square REST API client (no SDK — direct fetch).
//
// Uses a Personal Access Token model: we assume one Square account belongs to
// the operator. OAuth would be needed for multi-tenant; for a single-merchant
// catering app a PAT is the right call. Required env:
//
//   SQUARE_ACCESS_TOKEN          - access token from Square dashboard
//   SQUARE_LOCATION_ID           - location id to bill from
//   SQUARE_ENVIRONMENT           - "sandbox" | "production" (default: sandbox)
//   SQUARE_WEBHOOK_SIGNATURE_KEY - signature key for webhook verification
//
// Money values: Square uses smallest currency units (cents). All converters
// here use USD; revisit for multi-currency.

import { createHmac } from "crypto";
import { randomUUID } from "crypto";
import type {
  CateringInquiry,
  QuoteAdjustment,
  QuoteLineItem,
} from "@workspace/db/schema";
import { computeQuoteTotals } from "./quote";

const SQUARE_VERSION = "2024-12-18";

// ── Config ────────────────────────────────────────────────────────────────────

export type SquareConfig = {
  accessToken: string;
  locationId: string;
  baseUrl: string;
  webhookSignatureKey: string | null;
};

export function getSquareConfig(): SquareConfig | null {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();
  const locationId = process.env.SQUARE_LOCATION_ID?.trim();
  if (!accessToken || !locationId) return null;
  const env = (process.env.SQUARE_ENVIRONMENT?.trim().toLowerCase() === "production")
    ? "production"
    : "sandbox";
  const baseUrl = env === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
  const webhookSignatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim() || null;
  return { accessToken, locationId, baseUrl, webhookSignatureKey };
}

export function isSquareConfigured(): boolean {
  return getSquareConfig() !== null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

type SquareError = { code?: string; detail?: string; field?: string; category?: string };

export class SquareApiError extends Error {
  status: number;
  errors: SquareError[];
  constructor(status: number, errors: SquareError[], message?: string) {
    super(message ?? errors.map(e => `${e.code ?? "ERR"}: ${e.detail ?? ""}`).join("; ") || "Square API error");
    this.status = status;
    this.errors = errors;
  }
}

async function squareFetch<T>(
  cfg: SquareConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const resp = await fetch(`${cfg.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Authorization": `Bearer ${cfg.accessToken}`,
      "Content-Type": "application/json",
      "Square-Version": SQUARE_VERSION,
      "Accept": "application/json",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await resp.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!resp.ok) {
    const errors = (parsed && typeof parsed === "object" && "errors" in parsed
      ? (parsed as { errors?: SquareError[] }).errors
      : null) ?? [];
    throw new SquareApiError(resp.status, errors, `Square ${init.method ?? "GET"} ${path} -> ${resp.status}`);
  }
  return parsed as T;
}

// ── Money helpers ─────────────────────────────────────────────────────────────

function dollarsToCents(n: number): number {
  return Math.round(n * 100);
}
function centsToDollars(n: number | null | undefined): number {
  if (typeof n !== "number") return 0;
  return Math.round(n) / 100;
}
function moneyUSD(amountDollars: number) {
  return { amount: dollarsToCents(amountDollars), currency: "USD" };
}

// ── Order creation ────────────────────────────────────────────────────────────
//
// Square Invoices are billed against a Square Order. We build an Order with
// per-quote line items and one combined adjustment for fees / discounts so the
// total matches our server-computed total exactly.

type SquareLineItem = {
  name: string;
  quantity: string;
  base_price_money: { amount: number; currency: string };
  note?: string;
};

type SquareOrderResponse = {
  order: {
    id: string;
    location_id: string;
    version: number;
    total_money?: { amount: number };
  };
};

async function createOrderForInquiry(cfg: SquareConfig, inquiry: CateringInquiry): Promise<string> {
  const totals = computeQuoteTotals(
    inquiry.lineItems as QuoteLineItem[] | null,
    inquiry.fees as QuoteAdjustment[] | null,
    inquiry.discounts as QuoteAdjustment[] | null,
  );

  const lineItems: SquareLineItem[] = totals.lineItems.length > 0
    ? totals.lineItems.map(li => ({
        name: li.name || "Item",
        quantity: String(Math.max(1, Math.floor(li.quantity || 1))),
        base_price_money: moneyUSD(li.unitPrice),
        note: li.notes ?? undefined,
      }))
    : [{
        name: `Catering — Quote ${inquiry.quoteNumber ?? `#${inquiry.id}`}`,
        quantity: "1",
        base_price_money: moneyUSD(totals.subtotal || 0),
      }];

  // Combine fees / discounts as a single net adjustment so the Square total
  // matches our computed total to the cent.
  const netAdjustmentDollars = totals.feesTotal - totals.discountsTotal;
  const adjustments: Array<{ name: string; amount_money: { amount: number; currency: string } }> = [];
  if (Math.abs(netAdjustmentDollars) >= 0.01) {
    adjustments.push({
      name: netAdjustmentDollars >= 0 ? "Fees & adjustments" : "Discount",
      amount_money: moneyUSD(Math.abs(netAdjustmentDollars)),
    });
  }

  const idempotencyKey = `order-inq-${inquiry.id}-${Date.now()}-${randomUUID()}`;
  const body: Record<string, unknown> = {
    idempotency_key: idempotencyKey,
    order: {
      location_id: cfg.locationId,
      reference_id: `inquiry-${inquiry.id}`,
      line_items: lineItems,
      ...(adjustments.length > 0 && netAdjustmentDollars >= 0
        ? { service_charges: adjustments.map(a => ({ ...a, calculation_phase: "TOTAL_PHASE" })) }
        : {}),
      ...(adjustments.length > 0 && netAdjustmentDollars < 0
        ? { discounts: adjustments.map(a => ({ ...a, scope: "ORDER" })) }
        : {}),
    },
  };

  const resp = await squareFetch<SquareOrderResponse>(cfg, "/v2/orders", { method: "POST", body });
  return resp.order.id;
}

// ── Invoice create + publish ──────────────────────────────────────────────────

export type DepositSpec =
  | { kind: "none" }
  | { kind: "percent"; value: number }   // e.g. 25 for 25%
  | { kind: "fixed"; value: number };    // dollars

type SquareInvoice = {
  id: string;
  version: number;
  order_id: string;
  status: string;
  public_url?: string | null;
  payment_requests?: Array<Record<string, unknown>>;
  next_payment_amount_money?: { amount: number };
};

type SquareInvoiceResponse = { invoice: SquareInvoice };

export type CreatedInvoice = {
  invoiceId: string;
  invoiceVersion: number;
  orderId: string;
  status: string;
  hostedUrl: string | null;
  balanceDueCents: number;
};

export async function createAndPublishInvoiceForInquiry(opts: {
  inquiry: CateringInquiry;
  deposit: DepositSpec;
  dueDate: string | null;        // ISO date, YYYY-MM-DD
}): Promise<CreatedInvoice> {
  const cfg = getSquareConfig();
  if (!cfg) throw new Error("Square is not configured");

  const { inquiry, deposit, dueDate } = opts;

  if (!inquiry.clientEmail?.trim()) {
    throw new Error("Square invoices require the client to have an email on file");
  }

  const totals = computeQuoteTotals(
    inquiry.lineItems as QuoteLineItem[] | null,
    inquiry.fees as QuoteAdjustment[] | null,
    inquiry.discounts as QuoteAdjustment[] | null,
  );
  if (totals.total <= 0) {
    throw new Error("Quote total must be greater than $0 to invoice");
  }

  // 1) Customer (find-or-create by email)
  const customerId = await ensureCustomer(cfg, {
    email: inquiry.clientEmail.trim(),
    givenName: inquiry.clientName,
    phone: inquiry.clientPhone,
    organization: inquiry.organization,
  });

  // 2) Order
  const orderId = await createOrderForInquiry(cfg, inquiry);

  // 3) Build payment_requests array
  const dueIsoDate = dueDate ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const paymentRequests: Array<Record<string, unknown>> = [];

  if (deposit.kind === "none") {
    paymentRequests.push({
      request_type: "BALANCE",
      due_date: dueIsoDate,
      automatic_payment_source: "NONE",
    });
  } else {
    const depositAmountDollars = deposit.kind === "percent"
      ? Math.round(totals.total * (deposit.value / 100) * 100) / 100
      : Math.min(deposit.value, totals.total);

    paymentRequests.push({
      request_type: "DEPOSIT",
      due_date: dueIsoDate,
      fixed_amount_requested_money: moneyUSD(depositAmountDollars),
      automatic_payment_source: "NONE",
    });
    paymentRequests.push({
      request_type: "BALANCE",
      due_date: dueIsoDate,
      automatic_payment_source: "NONE",
    });
  }

  // 4) Create invoice (draft)
  const createBody = {
    idempotency_key: `inv-create-${inquiry.id}-${Date.now()}-${randomUUID()}`,
    invoice: {
      location_id: cfg.locationId,
      order_id: orderId,
      primary_recipient: { customer_id: customerId },
      payment_requests: paymentRequests,
      delivery_method: "EMAIL",
      accepted_payment_methods: { card: true, square_gift_card: false, bank_account: false },
      title: `Catering ${inquiry.quoteNumber ?? `Quote #${inquiry.id}`}`,
      description: inquiry.quoteNotes ?? `Catering order for ${inquiry.eventDate ?? "your event"}.`,
      scheduled_at: undefined,
    },
  };
  const created = await squareFetch<SquareInvoiceResponse>(cfg, "/v2/invoices", {
    method: "POST",
    body: createBody,
  });

  // 5) Publish — this triggers Square to email the customer
  const published = await squareFetch<SquareInvoiceResponse>(
    cfg,
    `/v2/invoices/${encodeURIComponent(created.invoice.id)}/publish`,
    {
      method: "POST",
      body: {
        version: created.invoice.version,
        idempotency_key: `inv-pub-${created.invoice.id}-${Date.now()}`,
      },
    },
  );

  return {
    invoiceId: published.invoice.id,
    invoiceVersion: published.invoice.version,
    orderId: published.invoice.order_id,
    status: published.invoice.status,
    hostedUrl: published.invoice.public_url ?? null,
    balanceDueCents: published.invoice.next_payment_amount_money?.amount ?? dollarsToCents(totals.total),
  };
}

// ── Customer find-or-create ───────────────────────────────────────────────────

type SquareCustomersSearchResp = { customers?: Array<{ id: string; email_address?: string }> };
type SquareCustomerResp = { customer: { id: string } };

async function ensureCustomer(cfg: SquareConfig, opts: {
  email: string;
  givenName: string;
  phone?: string | null;
  organization?: string | null;
}): Promise<string> {
  // 1) Search by email
  try {
    const search = await squareFetch<SquareCustomersSearchResp>(cfg, "/v2/customers/search", {
      method: "POST",
      body: {
        query: { filter: { email_address: { exact: opts.email } } },
        limit: 1,
      },
    });
    const found = search.customers?.[0];
    if (found?.id) return found.id;
  } catch {
    // fall through to create
  }

  // 2) Create
  const parts = (opts.givenName ?? "").trim().split(/\s+/);
  const givenName = parts[0] ?? "Guest";
  const familyName = parts.slice(1).join(" ") || undefined;

  const created = await squareFetch<SquareCustomerResp>(cfg, "/v2/customers", {
    method: "POST",
    body: {
      idempotency_key: `cust-${opts.email}-${Date.now()}`,
      given_name: givenName,
      family_name: familyName,
      email_address: opts.email,
      phone_number: opts.phone || undefined,
      company_name: opts.organization || undefined,
    },
  });
  return created.customer.id;
}

// ── Cancel ────────────────────────────────────────────────────────────────────

export async function cancelInvoice(invoiceId: string, version: number): Promise<{ status: string }> {
  const cfg = getSquareConfig();
  if (!cfg) throw new Error("Square is not configured");
  const resp = await squareFetch<SquareInvoiceResponse>(
    cfg,
    `/v2/invoices/${encodeURIComponent(invoiceId)}/cancel`,
    { method: "POST", body: { version } },
  );
  return { status: resp.invoice.status };
}

// ── Fetch single invoice (for refresh + webhook re-pull) ──────────────────────

export type InvoiceSnapshot = {
  invoiceId: string;
  invoiceVersion: number;
  orderId: string;
  status: string;
  hostedUrl: string | null;
  balanceDueDollars: number;
  amountPaidDollars: number;
};

export async function getInvoiceSnapshot(invoiceId: string): Promise<InvoiceSnapshot> {
  const cfg = getSquareConfig();
  if (!cfg) throw new Error("Square is not configured");
  const resp = await squareFetch<SquareInvoiceResponse>(
    cfg,
    `/v2/invoices/${encodeURIComponent(invoiceId)}`,
    { method: "GET" },
  );

  // Compute amount paid by summing completed payment requests (best-effort).
  // Square also returns the running balance via next_payment_amount_money.
  let amountPaidCents = 0;
  let totalRequestedCents = 0;
  for (const pr of resp.invoice.payment_requests ?? []) {
    const req = pr as {
      total_completed_amount_money?: { amount?: number };
      computed_amount_money?: { amount?: number };
      fixed_amount_requested_money?: { amount?: number };
    };
    amountPaidCents += req.total_completed_amount_money?.amount ?? 0;
    totalRequestedCents += req.computed_amount_money?.amount
      ?? req.fixed_amount_requested_money?.amount
      ?? 0;
  }
  const balanceDueCents = resp.invoice.next_payment_amount_money?.amount
    ?? Math.max(0, totalRequestedCents - amountPaidCents);

  return {
    invoiceId: resp.invoice.id,
    invoiceVersion: resp.invoice.version,
    orderId: resp.invoice.order_id,
    status: resp.invoice.status,
    hostedUrl: resp.invoice.public_url ?? null,
    balanceDueDollars: centsToDollars(balanceDueCents),
    amountPaidDollars: centsToDollars(amountPaidCents),
  };
}

// ── Webhook signature verification ────────────────────────────────────────────
// https://developer.squareup.com/docs/webhooks/step3validate

export function verifyWebhookSignature(opts: {
  signatureKey: string;
  notificationUrl: string;
  rawBody: string;
  signatureHeader: string;
}): boolean {
  const stringToSign = `${opts.notificationUrl}${opts.rawBody}`;
  const expected = createHmac("sha256", opts.signatureKey)
    .update(stringToSign)
    .digest("base64");
  // constant-time compare
  if (expected.length !== opts.signatureHeader.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ opts.signatureHeader.charCodeAt(i);
  }
  return mismatch === 0;
}
