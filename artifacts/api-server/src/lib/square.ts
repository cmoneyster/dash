// Square REST API client (no SDK — direct fetch).
//
// Uses a Personal Access Token model: we assume one Square account belongs to
// the operator. OAuth would be needed for multi-tenant; for a single-merchant
// catering app a PAT is the right call. Required env:
//
//   SQUARE_ACCESS_TOKEN          - access token for invoicing integration
//   SQUARE_LOCATION_ID           - location id to bill from
//   SQUARE_ENVIRONMENT           - "sandbox" | "production" (default: sandbox)
//   SQUARE_WEBHOOK_SIGNATURE_KEY - signature key for webhook verification
//
// Terminal API uses separate credentials so the invoicing integration is
// not disturbed:
//
//   SQUARE_TERMINAL_ACCESS_TOKEN - access token for Terminal API app
//   SQUARE_TERMINAL_LOCATION_ID  - (optional) falls back to SQUARE_LOCATION_ID
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
import { computeQuoteTotals, fmtDeliveryWindow } from "./quote";

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

// Separate credentials for the Terminal API integration so the invoicing
// app is not disturbed. Requires SQUARE_TERMINAL_ACCESS_TOKEN; location
// falls back to SQUARE_LOCATION_ID if SQUARE_TERMINAL_LOCATION_ID is unset.
export function getTerminalSquareConfig(): SquareConfig | null {
  const accessToken = process.env.SQUARE_TERMINAL_ACCESS_TOKEN?.trim();
  const locationId = (process.env.SQUARE_TERMINAL_LOCATION_ID?.trim())
    || process.env.SQUARE_LOCATION_ID?.trim();
  if (!accessToken || !locationId) return null;
  const env = (process.env.SQUARE_ENVIRONMENT?.trim().toLowerCase() === "production")
    ? "production"
    : "sandbox";
  const baseUrl = env === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
  return { accessToken, locationId, baseUrl, webhookSignatureKey: null };
}

export function isTerminalSquareConfigured(): boolean {
  return getTerminalSquareConfig() !== null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

type SquareError = { code?: string; detail?: string; field?: string; category?: string };

export class SquareApiError extends Error {
  status: number;
  errors: SquareError[];
  // Human-readable diagnostic string built from Square's errors[].detail/code
  // fields. Use this in user-facing API responses; use `message` only in logs
  // (it carries the transport path/status wrapper for traceability).
  userMessage: string;
  constructor(status: number, errors: SquareError[], message?: string) {
    super(message ?? (errors.map(e => `${e.code ?? "ERR"}: ${e.detail ?? ""}`).join("; ") || "Square API error"));
    this.status = status;
    this.errors = errors;
    this.userMessage = errors
      .map(e => e.detail?.trim() || e.code?.trim() || "")
      .filter(Boolean)
      .join("; ") || "Square API error";
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

// ── Date helpers ──────────────────────────────────────────────────────────────

// Subtract N calendar days from an ISO date string (YYYY-MM-DD) and return
// the result as YYYY-MM-DD. Uses UTC arithmetic to avoid DST surprises.
function subtractDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
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

// Build a Square order from arbitrary line-item / fee / discount arrays.
// Used by both the primary invoice path (rows pulled from the inquiry) and
// the supplemental invoice path (rows = uninvoiced delta).
//
// `referenceId` lands on the Square order and is what shows up in the Square
// dashboard search; `fallbackName` is the single-line description we use
// when the caller passes an empty `lineItems` (only the primary path ever
// hits this — the supplemental handler refuses to publish on empty rows).
async function createOrderFromRows(
  cfg: SquareConfig,
  opts: {
    referenceId: string;
    lineItems: QuoteLineItem[] | null;
    fees: QuoteAdjustment[] | null;
    discounts: QuoteAdjustment[] | null;
    fallbackName: string;
    idempotencyKey: string;
    // When set, an additive ORDER-scope tax line is added to the Square order
    // so the invoice shows a separate tax line and a tax-inclusive total.
    // Expressed as a percentage, e.g. 8.875 for 8.875%.
    salesTaxPercent?: number | null;
  },
): Promise<string> {
  const totals = computeQuoteTotals(opts.lineItems, opts.fees, opts.discounts);

  const lineItems: SquareLineItem[] = totals.lineItems.length > 0
    ? totals.lineItems.map(li => ({
        name: li.name || "Item",
        quantity: String(Math.max(1, Math.floor(li.quantity || 1))),
        base_price_money: moneyUSD(li.unitPrice),
        note: li.notes ?? undefined,
      }))
    : [{
        name: opts.fallbackName,
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

  // Sales tax: Square's Orders API does not auto-apply location taxes from the
  // dashboard — we must pass the tax explicitly. scope=ORDER applies it to all
  // line items automatically without per-item applied_taxes references.
  const taxes: Array<Record<string, unknown>> = [];
  if (opts.salesTaxPercent && opts.salesTaxPercent > 0) {
    taxes.push({
      uid: "catering-sales-tax",
      name: "Sales Tax",
      percentage: String(opts.salesTaxPercent),
      scope: "ORDER",
      type: "ADDITIVE",
    });
  }

  const body: Record<string, unknown> = {
    idempotency_key: opts.idempotencyKey,
    order: {
      location_id: cfg.locationId,
      reference_id: opts.referenceId,
      line_items: lineItems,
      ...(adjustments.length > 0 && netAdjustmentDollars >= 0
        ? { service_charges: adjustments.map(a => ({ ...a, calculation_phase: "TOTAL_PHASE" })) }
        : {}),
      ...(adjustments.length > 0 && netAdjustmentDollars < 0
        ? { discounts: adjustments.map(a => ({ ...a, scope: "ORDER" })) }
        : {}),
      ...(taxes.length > 0 ? { taxes } : {}),
    },
  };

  const resp = await squareFetch<SquareOrderResponse>(cfg, "/v2/orders", { method: "POST", body });
  return resp.order.id;
}

async function createOrderForInquiry(
  cfg: SquareConfig,
  inquiry: CateringInquiry,
  salesTaxPercent?: number | null,
): Promise<string> {
  return createOrderFromRows(cfg, {
    referenceId: `inquiry-${inquiry.id}`,
    lineItems: inquiry.lineItems as QuoteLineItem[] | null,
    fees: inquiry.fees as QuoteAdjustment[] | null,
    discounts: inquiry.discounts as QuoteAdjustment[] | null,
    fallbackName: `Catering — Quote ${inquiry.quoteNumber ?? `#${inquiry.id}`}`,
    idempotencyKey: `order-inq-${inquiry.id}-${Date.now()}-${randomUUID()}`,
    salesTaxPercent,
  });
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
  customerId: string;
  // Computed balance due date (YYYY-MM-DD) so callers can persist it without
  // re-deriving the smart default logic.
  balanceDueDate: string;
};

export async function createAndPublishInvoiceForInquiry(opts: {
  inquiry: CateringInquiry;
  deposit: DepositSpec;
  dueDate: string | null;        // ISO date, YYYY-MM-DD — balance-due override
  depositDueDate?: string | null; // ISO date, YYYY-MM-DD — deposit-due override
  // Catering sales tax rate (percentage, e.g. 8.875). When provided and > 0,
  // a tax line is added to the Square order. Callers should read this from
  // event settings rather than computing it themselves.
  salesTaxPercent?: number | null;
}): Promise<CreatedInvoice> {
  const cfg = getSquareConfig();
  if (!cfg) throw new Error("Square is not configured");

  const { inquiry, deposit, dueDate, depositDueDate, salesTaxPercent } = opts;

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
  const orderId = await createOrderForInquiry(cfg, inquiry, salesTaxPercent);

  // 3) Build payment_requests array.
  //
  // Business rules for due dates:
  //   Deposit  — due 14 days before the event date, or today if the event is
  //              within 14 days (i.e. max(today, eventDate − 14 days)).
  //   Balance  — due 3 days before the event date (overrideable via `dueDate`).
  //
  // When no event date is set we fall back to: deposit = today,
  // balance = +14 days from today (prior behaviour).
  //
  // Square requires every payment_request on an invoice to have a *different*
  // due_date. If the computed deposit and balance dates collide the balance is
  // bumped out by one day.
  const todayIsoDate = new Date().toISOString().slice(0, 10);
  let smartDepositDue: string;
  let smartBalanceDue: string;
  if (inquiry.eventDate) {
    const depositTarget = subtractDays(inquiry.eventDate, 14);
    const computedDepositDue = depositTarget <= todayIsoDate ? todayIsoDate : depositTarget;
    smartDepositDue = depositDueDate?.trim() || computedDepositDue;
    smartBalanceDue = dueDate ?? subtractDays(inquiry.eventDate, 3);
  } else {
    smartDepositDue = depositDueDate?.trim() || todayIsoDate;
    smartBalanceDue = dueDate ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  const paymentRequests: Array<Record<string, unknown>> = [];

  if (deposit.kind === "none") {
    paymentRequests.push({
      request_type: "BALANCE",
      due_date: smartBalanceDue,
      automatic_payment_source: "NONE",
    });
  } else {
    const depositAmountDollars = deposit.kind === "percent"
      ? Math.round(totals.total * (deposit.value / 100) * 100) / 100
      : Math.min(deposit.value, totals.total);

    let depositDueIsoDate = smartDepositDue;
    let balanceDueAdjusted = smartBalanceDue;
    while (depositDueIsoDate >= balanceDueAdjusted) {
      // Keep bumping the balance forward until it is strictly after the deposit.
      const next = new Date(`${balanceDueAdjusted}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      balanceDueAdjusted = next.toISOString().slice(0, 10);
    }

    paymentRequests.push({
      request_type: "DEPOSIT",
      due_date: depositDueIsoDate,
      fixed_amount_requested_money: moneyUSD(depositAmountDollars),
      automatic_payment_source: "NONE",
    });
    paymentRequests.push({
      request_type: "BALANCE",
      due_date: balanceDueAdjusted,
      automatic_payment_source: "NONE",
    });
    // Capture the final adjusted balance date for the return value.
    smartBalanceDue = balanceDueAdjusted;
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
      description: inquiry.quoteNotes ?? `Catering order for ${inquiry.eventDate ?? "your event"}${inquiry.eventTime ? ` · Delivery ${fmtDeliveryWindow(inquiry.eventTime)}` : ""}.`,
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
    customerId,
    balanceDueDate: smartBalanceDue,
  };
}

// ── Supplemental invoice (post-event extras) ─────────────────────────────────
//
// Issues an additional Square invoice billed to the same customer as the
// inquiry's primary invoice, containing only the delta rows the caller
// supplies (the "uninvoiced delta"). Single BALANCE payment_request due
// today — there is no second deposit/balance schedule.
//
// The primary invoice is never touched: this is purely additive. The caller
// is responsible for computing the delta (use `computeUninvoicedDelta`
// from `@workspace/pricing`) and persisting the resulting child row to
// `cateringSupplementalInvoicesTable`.

export async function createAndPublishSupplementalInvoice(opts: {
  inquiry: CateringInquiry;
  lineItems: QuoteLineItem[];
  fees: QuoteAdjustment[];
  discounts: QuoteAdjustment[];
  // Per-inquiry monotonic sequence used in the Square invoice title /
  // description so the merchant + customer can tell supplementals apart
  // ("Supplemental #1", "#2", …).
  supplementSeq: number;
  // The exact Square customer id the primary invoice was billed to.
  // Required (not optional) to guarantee the supplemental binds to the
  // SAME Square customer as the primary, even if the admin edited
  // `clientEmail` on the inquiry after publishing the primary. The
  // caller is responsible for sourcing this from the inquiry's
  // persisted `squareCustomerId`.
  primaryCustomerId: string;
  // Primary invoice number (e.g. "INV-001") for cross-reference in the
  // supplemental description, so the customer can match it to the
  // primary invoice they already received.
  primaryInvoiceNumber?: string | null;
  // Catering sales tax rate — same value used by the primary invoice so
  // the tax presentation is consistent across both invoices.
  salesTaxPercent?: number | null;
}): Promise<CreatedInvoice> {
  const cfg = getSquareConfig();
  if (!cfg) throw new Error("Square is not configured");

  const { inquiry, lineItems, fees, discounts, supplementSeq, primaryCustomerId, primaryInvoiceNumber } = opts;

  if (!primaryCustomerId.trim()) {
    throw new Error("Supplemental invoice requires the primary invoice's Square customer id");
  }

  const totals = computeQuoteTotals(lineItems, fees, discounts);
  if (totals.total <= 0) {
    throw new Error("Supplemental invoice total must be greater than $0");
  }

  // 1) Bind to the EXACT Square customer that the primary invoice was
  // sent to — never re-resolve by current email. The primary's customer
  // id is the source of truth; if `clientEmail` was edited after the
  // primary publish, we must still bill the original customer.
  const customerId = primaryCustomerId.trim();

  // 2) Order built from the delta rows
  const orderId = await createOrderFromRows(cfg, {
    referenceId: `inquiry-${inquiry.id}-supp-${supplementSeq}`,
    lineItems,
    fees,
    discounts,
    fallbackName: `Supplemental #${supplementSeq} — Quote ${inquiry.quoteNumber ?? `#${inquiry.id}`}`,
    idempotencyKey: `order-inq-${inquiry.id}-supp-${supplementSeq}-${Date.now()}-${randomUUID()}`,
    salesTaxPercent: opts.salesTaxPercent,
  });

  // 3) Single BALANCE payment_request due today.
  const todayIsoDate = new Date().toISOString().slice(0, 10);
  const paymentRequests = [{
    request_type: "BALANCE",
    due_date: todayIsoDate,
    automatic_payment_source: "NONE",
  }];

  // 4) Create invoice (draft).
  //
  // Title + description deliberately reference the primary invoice by
  // its Square invoice number (and our quote number) so the customer
  // can match this supplemental email to the original invoice they
  // already received. Falls back gracefully if either is missing.
  const titleSuffix = `Supplemental #${supplementSeq}`;
  const quoteRef = inquiry.quoteNumber ?? `Quote #${inquiry.id}`;
  const primaryRef = primaryInvoiceNumber?.trim()
    ? `Invoice ${primaryInvoiceNumber.trim()}`
    : quoteRef;
  const createBody = {
    idempotency_key: `inv-create-supp-${inquiry.id}-${supplementSeq}-${Date.now()}-${randomUUID()}`,
    invoice: {
      location_id: cfg.locationId,
      order_id: orderId,
      primary_recipient: { customer_id: customerId },
      payment_requests: paymentRequests,
      delivery_method: "EMAIL",
      accepted_payment_methods: { card: true, square_gift_card: false, bank_account: false },
      title: `Catering ${quoteRef} — ${titleSuffix}`,
      description:
        `Additional charges for your catering order${inquiry.eventDate ? ` on ${inquiry.eventDate}` : ""}${inquiry.eventTime ? ` · Delivery ${fmtDeliveryWindow(inquiry.eventTime)}` : ""}. `
        + `This is a separate invoice that supplements ${primaryRef}; the original invoice is unchanged.`,
      scheduled_at: undefined,
    },
  };
  const created = await squareFetch<SquareInvoiceResponse>(cfg, "/v2/invoices", {
    method: "POST",
    body: createBody,
  });

  // 5) Publish — Square emails the customer.
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
    customerId,
    balanceDueDate: todayIsoDate,
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
// ── Square Terminal (card-present POS) ────────────────────────────────────────
//
// Used by the Staff Order Taker to push a charge to a physical Square Terminal
// device without the cashier manually entering the amount. Requires the same
// SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID as invoices, plus a device ID
// stored in event_settings.square_terminal_device_id.
//
// Checkout lifecycle: PENDING → IN_PROGRESS → COMPLETED | CANCELED

export type TerminalCheckoutStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "CANCEL_REQUESTED"
  | "CANCELED"
  | "COMPLETED";

type TerminalCheckoutResp = {
  checkout: { id: string; status: TerminalCheckoutStatus };
};

export async function createTerminalCheckout(opts: {
  deviceId: string;
  amountCents: number;
  referenceId?: string;
  idempotencyKey: string;
}): Promise<{ checkoutId: string }> {
  const cfg = getTerminalSquareConfig();
  if (!cfg) throw new Error("Square Terminal is not configured — set SQUARE_TERMINAL_ACCESS_TOKEN");
  const resp = await squareFetch<TerminalCheckoutResp>(cfg, "/v2/terminals/checkouts", {
    method: "POST",
    body: {
      idempotency_key: opts.idempotencyKey,
      checkout: {
        amount_money: { amount: opts.amountCents, currency: "USD" },
        device_options: {
          device_id: opts.deviceId,
          skip_receipt_screen: true,
        },
        payment_type: "CARD_PRESENT",
        location_id: cfg.locationId,
        ...(opts.referenceId ? { reference_id: opts.referenceId } : {}),
      },
    },
  });
  return { checkoutId: resp.checkout.id };
}

export async function getTerminalCheckout(
  checkoutId: string,
): Promise<{ status: TerminalCheckoutStatus }> {
  const cfg = getTerminalSquareConfig();
  if (!cfg) throw new Error("Square Terminal is not configured — set SQUARE_TERMINAL_ACCESS_TOKEN");
  const resp = await squareFetch<TerminalCheckoutResp>(
    cfg,
    `/v2/terminals/checkouts/${encodeURIComponent(checkoutId)}`,
  );
  return { status: resp.checkout.status };
}

// ── List Terminal devices ─────────────────────────────────────────────────────
//
// Calls /v2/devices and filters to TERMINAL-type devices so the admin UI can
// present a browsable picker instead of requiring manual UUID entry.

export type TerminalDevice = {
  id: string;
  name: string;
  model: string;
};

type DevicesListResp = {
  devices?: Array<{
    id?: string;
    attributes?: {
      type?: string;
      name?: string;
      model?: string;
    };
  }>;
};

export async function listTerminalDevices(): Promise<TerminalDevice[]> {
  const cfg = getTerminalSquareConfig();
  if (!cfg) throw new Error("Square Terminal is not configured — set SQUARE_TERMINAL_ACCESS_TOKEN");
  const resp = await squareFetch<DevicesListResp>(cfg, "/v2/devices");
  const devices = resp.devices ?? [];
  return devices
    .filter(d => d.attributes?.type === "TERMINAL" && d.id)
    .map(d => ({
      id: d.id!,
      name: d.attributes?.name?.trim() || "Unnamed Terminal",
      model: d.attributes?.model?.trim() || "",
    }));
}

export async function cancelTerminalCheckout(checkoutId: string): Promise<void> {
  const cfg = getTerminalSquareConfig();
  if (!cfg) throw new Error("Square Terminal is not configured — set SQUARE_TERMINAL_ACCESS_TOKEN");
  await squareFetch(cfg, `/v2/terminals/checkouts/${encodeURIComponent(checkoutId)}/cancel`, {
    method: "POST",
  });
}

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
