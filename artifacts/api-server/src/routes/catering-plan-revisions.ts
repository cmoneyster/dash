import { Router, type IRouter, type Request } from "express";
import { randomBytes, randomUUID, createHash } from "crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  cateringInquiriesTable,
  cateringPlanLinksTable,
  cateringPlanRevisionsTable,
  menuCategoriesTable,
  menuItemsTable,
  type CateringPlanItemSnapshot,
  type CateringPlanSnapshot,
  type QuoteLineItem,
} from "@workspace/db/schema";
import { computeQuoteTotals } from "../lib/quote";
import { sendQuoteResponseAlert, sendMail } from "../lib/mail";
import { sendQuoteResponseSms } from "../lib/sms";
import { sendToCustomerGuarded } from "../lib/sms-inbox";
import { computeEffectivePriceDetail } from "@workspace/pricing";
import {
  isValidEventDate,
  isValidGuestCount,
  isValidRevisionQuantity,
  isPublicMenuCategory,
  mergePlanLineItems,
  choosePlanLink,
  effectivePricesMatch,
  publicMenuItems,
  sameRevisionBaseSnapshot,
  planSelectionKey,
  stableJson,
} from "../lib/catering-plan-revision-helpers";
import { getSmsOutboundMode } from "../lib/sms-ejoin";

const router: IRouter = Router();
const DAY_MS = 24 * 60 * 60 * 1000;
const REVISIONABLE_STATUSES = new Set(["inquiry", "quoted"]);
type RevisionItemWithTier = CateringPlanItemSnapshot & {
  tierApplied?: boolean;
  catalogUnitPrice?: number | null;
  catalogAvailable?: boolean;
  catalogVisible?: boolean;
};

type EditableFields = Pick<CateringPlanSnapshot,
  "eventDate" | "eventTime" | "guestCount" | "venueAddress" | "menuNotes">;

function publicBaseUrl(req: Request): string {
  const env = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (env) return env;
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0] || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}

async function revokeNewLink(id: number, token: string, created: boolean): Promise<void> {
  if (!created) return;
  await db.update(cateringPlanLinksTable)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(cateringPlanLinksTable.inquiryId, id),
      eq(cateringPlanLinksTable.token, token),
      isNull(cateringPlanLinksTable.revokedAt),
    ));
}

function menuItemsOf(inquiry: typeof cateringInquiriesTable.$inferSelect): QuoteLineItem[] {
  return (inquiry.lineItems ?? []).filter(
    (item): item is QuoteLineItem => item.menuItemId != null && Number.isInteger(Number(item.menuItemId)),
  );
}

function planItems(inquiry: typeof cateringInquiriesTable.$inferSelect): CateringPlanItemSnapshot[] {
  return menuItemsOf(inquiry).map((item) => ({
    menuItemId: Number(item.menuItemId),
    name: item.name,
    quantity: Number(item.quantity),
    sizeSlot: item.sizeSlot ?? null,
    sizeLabel: item.sizeLabel ?? null,
    unitPrice: Number(item.unitPrice),
    pricingTemplate: item.pricingTemplate ?? null,
    lineItemId: item.id,
    notes: item.notes ?? null,
    priceMode: item.priceMode ?? null,
    sizeServings: item.sizeServings ?? null,
    unit: item.unit ?? null,
    servingSize: item.servingSize ?? null,
    tierApplied: item.tierApplied ?? false,
  } as RevisionItemWithTier));
}

function snapshot(inquiry: typeof cateringInquiriesTable.$inferSelect): CateringPlanSnapshot {
  return {
    items: planItems(inquiry),
    eventDate: inquiry.eventDate,
    eventTime: inquiry.eventTime,
    guestCount: inquiry.guestCount,
    venueAddress: inquiry.venueAddress,
    menuNotes: inquiry.menuNotes,
    quoteLineItems: (inquiry.lineItems ?? []) as unknown[],
    staffQuoteSnapshot: {
      fees: inquiry.fees ?? [],
      discounts: inquiry.discounts ?? [],
      quoteNotes: inquiry.quoteNotes,
      subtotal: inquiry.subtotal,
      feesTotal: inquiry.feesTotal,
      discountsTotal: inquiry.discountsTotal,
      total: inquiry.total,
      serviceMode: inquiry.serviceMode,
      otdSetupFee: inquiry.otdSetupFee,
      otdFeeWaiverThreshold: inquiry.otdFeeWaiverThreshold,
      otdIncludedHours: inquiry.otdIncludedHours,
      otdAdditionalHourRate: inquiry.otdAdditionalHourRate,
      otdMaxAdditionalHours: inquiry.otdMaxAdditionalHours,
      status: inquiry.status,
      quoteNumber: inquiry.quoteNumber,
      quoteToken: inquiry.quoteToken,
      quoteIssuedAt: inquiry.quoteIssuedAt?.toISOString() ?? null,
      quoteExpiresAt: inquiry.quoteExpiresAt?.toISOString() ?? null,
    },
  } as CateringPlanSnapshot;
}

function internalSnapshot(s: CateringPlanSnapshot): unknown {
  const extended = s as CateringPlanSnapshot & { staffQuoteSnapshot?: unknown };
  return {
    editable: {
      items: s.items,
      eventDate: s.eventDate,
      eventTime: s.eventTime,
      guestCount: s.guestCount,
      venueAddress: s.venueAddress,
      menuNotes: s.menuNotes,
    },
    quoteLineItems: s.quoteLineItems ?? [],
    staffQuoteSnapshot: extended.staffQuoteSnapshot ?? null,
  };
}

function publicVersion(s: CateringPlanSnapshot): string {
  // The revision form's optimistic version covers precisely the current
  // customer-editable plan data; staff-only quote rows remain merge-safe.
  const data = {
    items: s.items.map(({ menuItemId, name, quantity, sizeSlot, sizeLabel, pricingTemplate }) =>
      ({ menuItemId, name, quantity, sizeSlot, sizeLabel, pricingTemplate })),
    eventDate: s.eventDate,
    eventTime: s.eventTime,
    guestCount: s.guestCount,
    venueAddress: s.venueAddress,
    menuNotes: s.menuNotes,
  };
  return createHash("sha256").update(stableJson(data)).digest("hex");
}

function hasIssuedQuote(inquiry: typeof cateringInquiriesTable.$inferSelect): boolean {
  return inquiry.quoteIssuedAt != null && inquiry.quoteToken != null;
}

function isRevisionable(inquiry: typeof cateringInquiriesTable.$inferSelect): boolean {
  return REVISIONABLE_STATUSES.has(inquiry.status)
    && !inquiry.quoteAcceptedAt
    && !inquiry.squareInvoiceId
    && !inquiry.squarePaidInFullAt;
}

function dateFields(body: Record<string, unknown>): EditableFields | null {
  const stringOrNull = (key: string, maxLength: number): string | null | undefined => {
    const value = body[key];
    if (value === null) return null;
    if (typeof value !== "string" || value.length > maxLength) return undefined;
    return value.trim() || null;
  };
  const eventDate = stringOrNull("eventDate", 40);
  const eventTime = stringOrNull("eventTime", 40);
  const venueAddress = stringOrNull("venueAddress", 1000);
  const menuNotes = stringOrNull("menuNotes", 4000);
  const rawGuests = body.guestCount;
  let guestCount: number | null | undefined;
  if (isValidGuestCount(rawGuests)) guestCount = rawGuests;
  else guestCount = undefined;
  if (
    eventDate === undefined || !isValidEventDate(eventDate) ||
    eventTime === undefined || venueAddress === undefined ||
    menuNotes === undefined || guestCount === undefined ||
    (eventTime && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(eventTime))
  ) return null;
  return { eventDate, eventTime, venueAddress, menuNotes, guestCount };
}

function currentLineItem(
  inquiry: typeof cateringInquiriesTable.$inferSelect,
  menuItemId: number,
  sizeSlot: number | null,
): QuoteLineItem | undefined {
  return menuItemsOf(inquiry).find((item) =>
    Number(item.menuItemId) === menuItemId && (item.sizeSlot ?? null) === sizeSlot);
}

function menuPrice(
  item: typeof menuItemsTable.$inferSelect,
  sizeSlot: number | null,
  quantity: number,
): { price: number; label: string | null; servings: number | null; tier: string } | null {
  if (item.pricingTemplate === "pan_sizes") {
    if (sizeSlot == null || sizeSlot < 1 || sizeSlot > 5) return null;
    const sizes = [
      { label: item.size1Label, price: item.size1Price, servings: item.size1Servings },
      { label: item.size2Label, price: item.size2Price, servings: item.size2Servings },
      { label: item.size3Label, price: item.size3Price, servings: item.size3Servings },
      { label: item.size4Label, price: item.size4Price, servings: item.size4Servings },
      { label: item.size5Label, price: item.size5Price, servings: item.size5Servings },
    ];
    const selected = sizes[sizeSlot - 1];
    const { label, price: rawPrice, servings } = selected;
    if (!label || rawPrice == null) return null;
    const effective = computeEffectivePriceDetail(item, quantity, rawPrice);
    return { ...effective, label, servings: servings ?? null };
  }
  if (sizeSlot != null) return null;
  const effective = computeEffectivePriceDetail(item, quantity, null);
  return { ...effective, label: null, servings: item.servingSize };
}

function formatMenuItem(item: typeof menuItemsTable.$inferSelect) {
  const sizes = item.pricingTemplate === "pan_sizes"
    ? [
      { slot: 1, label: item.size1Label, price: item.size1Price },
      { slot: 2, label: item.size2Label, price: item.size2Price },
      { slot: 3, label: item.size3Label, price: item.size3Price },
      { slot: 4, label: item.size4Label, price: item.size4Price },
      { slot: 5, label: item.size5Label, price: item.size5Price },
    ].flatMap((size) => size.label && size.price != null
      ? [{ slot: size.slot, label: size.label, price: Number(size.price) }]
      : [])
    : [];
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    price: Number(item.price),
    pricingTemplate: item.pricingTemplate,
    sizes,
    minimumOrderQty: item.minimumOrderQty,
  };
}

// Public editable plan read endpoint.
router.get("/plan/revise/:token", async (req, res): Promise<void> => {
  try {
    const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
    const [link] = await db.select().from(cateringPlanLinksTable)
      .where(and(eq(cateringPlanLinksTable.token, token), isNull(cateringPlanLinksTable.revokedAt)));
    if (!link || link.expiresAt <= new Date()) {
      res.status(404).json({ error: "Plan revision link not found or expired" });
      return;
    }
    const [inquiry] = await db.select().from(cateringInquiriesTable)
      .where(eq(cateringInquiriesTable.id, link.inquiryId));
    if (!inquiry || !isRevisionable(inquiry)) {
      res.status(410).json({ error: "This inquiry is no longer editable" });
      return;
    }
    const categories = await db.select().from(menuCategoriesTable);
    const allAvailableMenu = await db.select().from(menuItemsTable)
      .where(eq(menuItemsTable.available, true))
      .orderBy(menuItemsTable.category, menuItemsTable.name);
    const availableMenu = publicMenuItems(allAvailableMenu, categories);
    const currentPlanItems = planItems(inquiry);
    const currentMenuRows = currentPlanItems.length
      ? await db.select().from(menuItemsTable)
        .where(inArray(menuItemsTable.id, [...new Set(currentPlanItems.map((item) => item.menuItemId))]))
      : [];
    const currentMenuById = new Map(currentMenuRows.map((item) => [item.id, item]));
    const [pending] = await db.select({ id: cateringPlanRevisionsTable.id })
      .from(cateringPlanRevisionsTable)
      .where(and(
        eq(cateringPlanRevisionsTable.inquiryId, inquiry.id),
        eq(cateringPlanRevisionsTable.status, "pending"),
      )).limit(1);
    res.json({
      version: publicVersion(snapshot(inquiry)),
      inquiry: {
        clientName: inquiry.clientName,
        eventDate: inquiry.eventDate,
        eventTime: inquiry.eventTime,
        guestCount: inquiry.guestCount,
        venueAddress: inquiry.venueAddress,
        menuNotes: inquiry.menuNotes,
        serviceMode: inquiry.serviceMode,
      },
      items: currentPlanItems.map(({ menuItemId, name, quantity, sizeSlot, sizeLabel, pricingTemplate }) => {
        const catalogItem = currentMenuById.get(menuItemId);
        const indicativePrice = catalogItem?.available
          ? menuPrice(catalogItem, sizeSlot, quantity)?.price ?? 0
          : 0;
        return { menuItemId, name, quantity, sizeSlot, sizeLabel, unitPrice: indicativePrice, pricingTemplate };
      }),
      availableMenu: availableMenu.map(formatMenuItem),
      pending: Boolean(pending),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to load catering plan revision");
    res.status(500).json({ error: "Failed to load plan" });
  }
});

// Customer proposal creation is serialized with acceptance and review by
// taking a row lock on the inquiry. submissionId makes retries idempotent.
router.post("/plan/revise/:token", async (req, res): Promise<void> => {
  try {
    const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.version !== "string" || !body.version ||
        typeof body.submissionId !== "string" || !body.submissionId ||
        body.submissionId.length > 128 || !Array.isArray(body.items) ||
        typeof body.note !== "string" || body.note.length > 2000) {
      res.status(400).json({ error: "Invalid plan revision request" });
      return;
    }
    const note = body.note as string;
    const fields = dateFields(body);
    if (!fields) {
      res.status(400).json({ error: "Invalid event details" });
      return;
    }
    const requestedItems: Array<{ menuItemId: number; quantity: number; sizeSlot: number | null }> = [];
    const seen = new Set<string>();
    for (const raw of body.items) {
      if (!raw || typeof raw !== "object") {
        res.status(400).json({ error: "Invalid menu selection" });
        return;
      }
      const row = raw as Record<string, unknown>;
      const menuItemId = row.menuItemId;
      const quantity = row.quantity;
      const sizeSlot = row.sizeSlot == null ? null : row.sizeSlot;
      if (!Number.isInteger(menuItemId) || Number(menuItemId) <= 0 ||
          !isValidRevisionQuantity(quantity) ||
          (sizeSlot !== null && (!Number.isInteger(sizeSlot) || Number(sizeSlot) < 1 || Number(sizeSlot) > 5)) ||
          seen.has(planSelectionKey(Number(menuItemId), sizeSlot as number | null))) {
        res.status(400).json({ error: "Invalid menu selection" });
        return;
      }
      seen.add(planSelectionKey(Number(menuItemId), sizeSlot as number | null));
      requestedItems.push({ menuItemId: Number(menuItemId), quantity: Number(quantity), sizeSlot: sizeSlot as number | null });
    }

    const result = await db.transaction(async (tx) => {
      const [link] = await tx.select().from(cateringPlanLinksTable)
        .where(and(eq(cateringPlanLinksTable.token, token), isNull(cateringPlanLinksTable.revokedAt)))
        .for("update");
      if (!link || link.expiresAt <= new Date()) return { error: "Plan revision link not found or expired", status: 404 as const };
      const [inquiry] = await tx.select().from(cateringInquiriesTable)
        .where(eq(cateringInquiriesTable.id, link.inquiryId)).for("update");
      if (!inquiry || !isRevisionable(inquiry)) return { error: "This inquiry is no longer editable", status: 409 as const };

      const [duplicate] = await tx.select().from(cateringPlanRevisionsTable)
        .where(eq(cateringPlanRevisionsTable.submissionId, body.submissionId as string)).limit(1);
      if (duplicate) {
        if (duplicate.inquiryId !== inquiry.id) return { error: "submissionId has already been used", status: 409 as const };
        return { revisionId: duplicate.id, status: "pending" as const, created: false, inquiry };
      }
      const [pendingRevision] = await tx.select({ id: cateringPlanRevisionsTable.id })
        .from(cateringPlanRevisionsTable)
        .where(and(
          eq(cateringPlanRevisionsTable.inquiryId, inquiry.id),
          eq(cateringPlanRevisionsTable.status, "pending"),
        )).limit(1);
      if (pendingRevision) {
        return { error: "A plan revision is already awaiting review", status: 409 as const };
      }
      const base = snapshot(inquiry);
      if (body.version !== publicVersion(base)) return { error: "Plan has changed; reload and try again", status: 409 as const };

      const itemRows = requestedItems.length
        ? await tx.select().from(menuItemsTable).where(inArray(menuItemsTable.id, requestedItems.map((i) => i.menuItemId)))
        : [];
      const categories = await tx.select().from(menuCategoriesTable);
      const menuById = new Map(itemRows.map((item) => [item.id, item]));
      const proposalItems: CateringPlanItemSnapshot[] = [];
      for (const requested of requestedItems) {
        const item = menuById.get(requested.menuItemId);
        const old = currentLineItem(inquiry, requested.menuItemId, requested.sizeSlot);
        if (!item) {
          if (old && old.quantity === requested.quantity) {
            proposalItems.push({
              menuItemId: requested.menuItemId,
              name: old.name,
              quantity: old.quantity,
              sizeSlot: old.sizeSlot ?? null,
              sizeLabel: old.sizeLabel ?? null,
              unitPrice: Number(old.unitPrice),
              pricingTemplate: old.pricingTemplate ?? null,
              lineItemId: old.id,
              notes: old.notes ?? null,
              priceMode: old.priceMode ?? null,
              sizeServings: old.sizeServings ?? null,
              unit: old.unit ?? null,
              servingSize: old.servingSize ?? null,
              tierApplied: old.tierApplied ?? false,
              catalogUnitPrice: null,
              catalogAvailable: false,
              catalogVisible: false,
            } as RevisionItemWithTier);
            continue;
          }
          return { error: "One or more selected items are unavailable", status: 400 as const };
        }
        const categoryVisible = isPublicMenuCategory(item.category, categories);
        if (!item.available || !categoryVisible) {
          if (old && old.quantity === requested.quantity) {
            proposalItems.push({
              menuItemId: item.id,
              name: old.name,
              quantity: old.quantity,
              sizeSlot: old.sizeSlot ?? null,
              sizeLabel: old.sizeLabel ?? null,
              unitPrice: Number(old.unitPrice),
              pricingTemplate: old.pricingTemplate ?? null,
              lineItemId: old.id,
              notes: old.notes ?? null,
              priceMode: old.priceMode ?? null,
              sizeServings: old.sizeServings ?? null,
              unit: old.unit ?? null,
              servingSize: old.servingSize ?? null,
              tierApplied: old.tierApplied ?? false,
              catalogUnitPrice: null,
              catalogAvailable: item.available,
              catalogVisible: categoryVisible,
            } as RevisionItemWithTier);
            continue;
          }
          return { error: "One or more selected items are unavailable", status: 400 as const };
        }
        if (requested.quantity < item.minimumOrderQty) {
          return { error: "One or more selected items are unavailable or below the minimum order quantity", status: 400 as const };
        }
        const priced = menuPrice(item, requested.sizeSlot, requested.quantity);
        if (!priced) return { error: `Choose a valid size for ${item.name}`, status: 400 as const };
        const manual = old?.priceMode === "manual";
        proposalItems.push({
          menuItemId: item.id,
          name: item.name,
          quantity: requested.quantity,
          sizeSlot: requested.sizeSlot,
          sizeLabel: priced.label,
          unitPrice: manual ? Number(old!.unitPrice) : priced.price,
          pricingTemplate: item.pricingTemplate === "pan_sizes" ? "pan_sizes" : "per_unit",
          lineItemId: old?.id,
          notes: old?.notes ?? null,
          priceMode: manual ? "manual" : "auto",
          sizeServings: priced.servings,
          unit: item.unit,
          servingSize: item.servingSize,
          tierApplied: manual
            ? old?.tierApplied ?? false
            : item.pricingTemplate === "per_unit" && priced.tier !== "base",
          catalogUnitPrice: priced.price,
          catalogAvailable: true,
          catalogVisible: true,
        } as RevisionItemWithTier);
      }
      const proposed: CateringPlanSnapshot = {
        items: proposalItems,
        ...fields,
        quoteLineItems: base.quoteLineItems,
      };
      const [created] = await tx.insert(cateringPlanRevisionsTable).values({
        inquiryId: inquiry.id,
        submissionId: body.submissionId as string,
        note: note.trim().slice(0, 2000),
        baseSnapshot: base,
        proposedSnapshot: proposed,
      }).onConflictDoNothing().returning();
      if (!created) {
        const [raced] = await tx.select().from(cateringPlanRevisionsTable)
          .where(eq(cateringPlanRevisionsTable.submissionId, body.submissionId as string));
        if (raced?.inquiryId === inquiry.id) {
          return { revisionId: raced.id, status: "pending" as const, created: false, inquiry };
        }
        return { error: "Unable to create revision", status: 409 as const };
      }
      return { revisionId: created.id, status: "pending" as const, created: true, inquiry };
    });
    if ("error" in result) {
      res.status(typeof result.status === "number" ? result.status : 409).json({ error: result.error });
      return;
    }
    if (result.created) {
      const adminLink = `${publicBaseUrl(req)}/admin/catering?inquiry=${result.inquiry.id}`;
      void sendQuoteResponseAlert({
        kind: "change_request",
        clientName: result.inquiry.clientName,
        quoteNumber: result.inquiry.quoteNumber,
        message: body.note as string,
        link: adminLink,
      }).catch((err) => req.log.error({ err }, "Plan revision email alert failed"));
      if (process.env.NODE_ENV === "production") {
        void sendQuoteResponseSms({
          kind: "change_request",
          clientName: result.inquiry.clientName,
          quoteNumber: result.inquiry.quoteNumber,
          message: body.note as string,
          link: adminLink,
        }).catch((err) => req.log.error({ err }, "Plan revision SMS alert failed"));
      }
    }
    res.json({ revisionId: result.revisionId, status: "pending" });
  } catch (err) {
    req.log.error({ err }, "Failed to submit catering plan revision");
    res.status(500).json({ error: "Failed to submit plan revision" });
  }
});

function adminSnapshot(s: CateringPlanSnapshot) {
  return {
    items: s.items.map(({ menuItemId, name, quantity, sizeSlot, sizeLabel, unitPrice, pricingTemplate }) =>
      ({ menuItemId, name, quantity, sizeSlot, sizeLabel, unitPrice, pricingTemplate })),
    eventDate: s.eventDate,
    eventTime: s.eventTime,
    guestCount: s.guestCount,
    venueAddress: s.venueAddress,
    menuNotes: s.menuNotes,
  };
}

router.get("/admin/catering/:id/plan-revisions", async (req, res): Promise<void> => {
  try {
    const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid inquiry id" });
      return;
    }
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }
    const [link] = await db.select().from(cateringPlanLinksTable)
      .where(eq(cateringPlanLinksTable.inquiryId, id));
    const revisions = await db.select().from(cateringPlanRevisionsTable)
      .where(eq(cateringPlanRevisionsTable.inquiryId, id))
      .orderBy(sql`${cateringPlanRevisionsTable.createdAt} DESC`);
    const usableLink = link && !link.revokedAt && link.expiresAt > new Date() && isRevisionable(inquiry)
      ? { url: `${publicBaseUrl(req)}/plan/revise/${link.token}`, expiresAt: link.expiresAt.toISOString() }
      : null;
    res.json({
      link: usableLink,
      revisions: revisions.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        status: r.status,
        note: r.note,
        base: adminSnapshot(r.baseSnapshot),
        proposed: adminSnapshot(r.proposedSnapshot),
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to load catering plan revisions");
    res.status(500).json({ error: "Failed to load plan revisions" });
  }
});

router.post("/admin/catering/:id/plan-link", async (req, res): Promise<void> => {
  let issuedLink: { token: string; created: boolean } | null = null;
  try {
    const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(id) || id <= 0 ||
        !["copy", "email", "sms"].includes(String(body.channel))) {
      res.status(400).json({ error: "Invalid link request" });
      return;
    }
    const newToken = randomBytes(32).toString("hex");
    const newExpiresAt = new Date(Date.now() + 30 * DAY_MS);
    const channel = body.channel as "copy" | "email" | "sms";
    const smsUnavailable = channel === "sms" &&
      (process.env.NODE_ENV !== "production" || getSmsOutboundMode() !== "live");
    const issueResult = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(cateringInquiriesTable)
        .where(eq(cateringInquiriesTable.id, id)).for("update");
      if (!row || !isRevisionable(row)) return { kind: "error" as const, error: "Inquiry not found or no longer editable", status: 404 as const };
      if (channel === "email" && !row.clientEmail?.trim()) {
        return { kind: "error" as const, error: "No client email on file", status: 400 as const };
      }
      if (channel === "sms" && !row.clientPhone?.trim()) {
        return { kind: "error" as const, error: "No client phone on file", status: 400 as const };
      }
      if (smsUnavailable) {
        req.log?.warn({ inquiryId: id, nodeEnv: process.env.NODE_ENV, outboundMode: getSmsOutboundMode() }, "Plan link SMS blocked by outbound mode");
        return { kind: "error" as const, error: "SMS delivery is disabled in this environment", status: 503 as const };
      }
      const [existingLink] = await tx.select().from(cateringPlanLinksTable)
        .where(eq(cateringPlanLinksTable.inquiryId, id)).for("update");
      const selectedLink = choosePlanLink(channel, existingLink, newToken, newExpiresAt, new Date());
      const { token, expiresAt, created } = selectedLink;
      if (created) {
        await tx.insert(cateringPlanLinksTable).values({
          inquiryId: id, token, expiresAt, revokedAt: null, createdAt: new Date(),
        }).onConflictDoUpdate({
          target: cateringPlanLinksTable.inquiryId,
          set: { token, expiresAt, revokedAt: null, createdAt: new Date() },
        });
      }
      return { kind: "ok" as const, inquiry: row, token, expiresAt, created };
    });
    if (issueResult.kind === "error") {
      res.status(issueResult.status).json({ error: issueResult.error });
      return;
    }
    const inquiry = issueResult.inquiry;
    const { token, expiresAt, created } = issueResult;
    issuedLink = { token, created };
    const url = `${publicBaseUrl(req)}/plan/revise/${token}`;
    if (body.channel === "email") {
      const result = await sendMail({
        to: inquiry.clientEmail?.trim() ?? "",
        subject: "Update your catering plan",
        text: `Hi ${inquiry.clientName},\n\nUse this secure link to review and update your catering plan: ${url}\n\nThis link expires in 30 days.`,
        html: `<p>Hi ${inquiry.clientName.replace(/[&<>"]/g, "")},</p><p><a href="${url}">Review and update your catering plan</a></p><p>This secure link expires in 30 days.</p>`,
      });
      if (!result.ok) {
        await revokeNewLink(id, token, created);
        res.status(502).json({ error: result.error ?? "Failed to send plan link" });
        return;
      }
    } else if (body.channel === "sms") {
      let sent;
      try {
        sent = await sendToCustomerGuarded({
          to: inquiry.clientPhone?.trim() ?? "",
          body: `Hi ${inquiry.clientName.split(" ")[0]}! Review your catering plan here: ${url}`,
          inquiryId: id,
          source: "system",
        });
      } catch (err) {
        req.log?.error({ err, inquiryId: id }, "Plan link SMS gateway failed");
        await revokeNewLink(id, token, created);
        issuedLink = null;
        res.status(502).json({ error: "SMS gateway could not send the plan link. Check SMS settings and try again." });
        return;
      }
      if (sent.status === "blocked") {
        await revokeNewLink(id, token, created);
        res.status(403).json({ error: sent.reason === "customer-opt-out" ? "Customer has opted out of SMS." : "This number is on the blocklist." });
        return;
      }
      if (sent.gatewayResponse === "suppressed:shadow-mode") {
        await revokeNewLink(id, token, created);
        req.log?.warn({ inquiryId: id }, "Plan link SMS suppressed after preflight");
        res.status(503).json({ error: "SMS delivery is disabled in this environment" });
        return;
      }
    }
    issuedLink = null;
    res.json({ url, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    if (issuedLink) {
      try {
        await revokeNewLink(Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id), issuedLink.token, issuedLink.created);
      } catch (revokeErr) {
        req.log.error({ err: revokeErr }, "Failed to revoke undelivered plan link");
      }
    }
    req.log.error({ err }, "Failed to issue catering plan link");
    res.status(500).json({ error: "Failed to issue plan link" });
  }
});

router.delete("/admin/catering/:id/plan-link", async (req, res): Promise<void> => {
  try {
    const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    await db.update(cateringPlanLinksTable)
      .set({ revokedAt: new Date() })
      .where(and(eq(cateringPlanLinksTable.inquiryId, id), isNull(cateringPlanLinksTable.revokedAt)));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to revoke catering plan link");
    res.status(500).json({ error: "Failed to revoke plan link" });
  }
});

router.post("/admin/catering/:id/plan-revisions/:revisionId/review", async (req, res): Promise<void> => {
  try {
    const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    const revisionId = Number(Array.isArray(req.params.revisionId) ? req.params.revisionId[0] : req.params.revisionId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(id) || !Number.isInteger(revisionId) ||
        (body.action !== "apply" && body.action !== "decline")) {
      res.status(400).json({ error: "Invalid review request" });
      return;
    }
    const outcome = await db.transaction(async (tx) => {
      const [inquiry] = await tx.select().from(cateringInquiriesTable)
        .where(eq(cateringInquiriesTable.id, id)).for("update");
      if (!inquiry) return "not-found" as const;
      const [revision] = await tx.select().from(cateringPlanRevisionsTable)
        .where(and(
          eq(cateringPlanRevisionsTable.id, revisionId),
          eq(cateringPlanRevisionsTable.inquiryId, id),
        )).for("update");
      if (!revision) return "revision-not-found" as const;
      if (revision.status !== "pending") return "already-reviewed" as const;
      const now = new Date(Math.max(Date.now(), inquiry.updatedAt.getTime() + 1));
      if (body.action === "decline") {
        await tx.update(cateringPlanRevisionsTable)
          .set({ status: "declined", reviewedAt: now })
          .where(and(eq(cateringPlanRevisionsTable.id, revisionId), eq(cateringPlanRevisionsTable.status, "pending")));
        return "ok" as const;
      }
      if (!isRevisionable(inquiry)) return "not-editable" as const;
      const base = revision.baseSnapshot;
      if (publicVersion(snapshot(inquiry)) !== publicVersion(base)) return "conflict" as const;
      const currentSnapshot = snapshot(inquiry);
      if (!sameRevisionBaseSnapshot(internalSnapshot(currentSnapshot), internalSnapshot(base))) return "conflict" as const;

      const proposed = revision.proposedSnapshot;
      const currentLines = inquiry.lineItems ?? [];
      const currentMenuLines = menuItemsOf(inquiry);
      const proposedIds = [...new Set(proposed.items.map((item) => item.menuItemId))];
      const catalogRows = proposedIds.length
        ? await tx.select().from(menuItemsTable).where(inArray(menuItemsTable.id, proposedIds))
        : [];
      const catalogById = new Map(catalogRows.map((item) => [item.id, item]));
      const categories = await tx.select().from(menuCategoriesTable);
      for (const item of proposed.items) {
        const revisionItem = item as RevisionItemWithTier;
        const catalogItem = catalogById.get(item.menuItemId);
        const currentlyAvailable = Boolean(catalogItem?.available);
        const currentlyVisible = catalogItem ? isPublicMenuCategory(catalogItem.category, categories) : false;
        if (revisionItem.catalogAvailable !== currentlyAvailable ||
            revisionItem.catalogVisible !== currentlyVisible) return "catalog-changed" as const;
        if (currentlyAvailable && currentlyVisible) {
          if (!catalogItem || item.quantity < catalogItem.minimumOrderQty) return "catalog-changed" as const;
          const currentPrice = menuPrice(catalogItem, item.sizeSlot ?? null, item.quantity);
          if (!currentPrice ||
              revisionItem.catalogUnitPrice == null ||
              !effectivePricesMatch(currentPrice.price, revisionItem.catalogUnitPrice) ||
              currentPrice.label !== item.sizeLabel ||
              (catalogItem.pricingTemplate === "pan_sizes" ? "pan_sizes" : "per_unit") !== item.pricingTemplate) {
            return "catalog-changed" as const;
          }
        } else {
          const unchangedOldItem = currentLineItem(inquiry, item.menuItemId, item.sizeSlot ?? null);
          if (!unchangedOldItem || unchangedOldItem.quantity !== item.quantity) return "catalog-changed" as const;
        }
      }
      const existingBySelection = new Map(currentMenuLines.map((line) => [
        planSelectionKey(Number(line.menuItemId), line.sizeSlot ?? null),
        line,
      ]));
      const updatedMenuLines: QuoteLineItem[] = proposed.items.map((item) => {
        const key = planSelectionKey(item.menuItemId, item.sizeSlot ?? null);
        const old = existingBySelection.get(key);
        const sameMenuItem = currentMenuLines.find((line) => Number(line.menuItemId) === item.menuItemId);
        const revisionItem = item as RevisionItemWithTier;
        const catalogItem = catalogById.get(item.menuItemId);
        const catalogPrice = catalogItem?.available && isPublicMenuCategory(catalogItem.category, categories)
          ? menuPrice(catalogItem, item.sizeSlot ?? null, item.quantity)
          : null;
        return {
          id: old?.id ?? randomUUID(),
          menuItemId: item.menuItemId,
          name: item.name,
          quantity: item.quantity,
          unitPrice: old?.priceMode === "manual"
            ? Number(old.unitPrice)
            : catalogPrice?.price ?? Number(old?.unitPrice ?? item.unitPrice),
          notes: old?.notes ?? sameMenuItem?.notes ?? item.notes ?? null,
          pricingTemplate: catalogItem?.pricingTemplate === "pan_sizes" ? "pan_sizes" : item.pricingTemplate,
          sizeSlot: item.sizeSlot,
          sizeLabel: catalogPrice?.label ?? item.sizeLabel,
          sizeServings: catalogPrice?.servings ?? item.sizeServings ?? null,
          unit: catalogItem?.unit ?? item.unit ?? old?.unit ?? null,
          servingSize: catalogItem?.servingSize ?? item.servingSize ?? old?.servingSize ?? null,
          tierApplied: old?.priceMode === "manual"
            ? old.tierApplied ?? false
            : revisionItem.tierApplied ?? false,
          priceMode: old?.priceMode === "manual" ? "manual" : "auto",
        };
      });
      // Existing staff-authored custom rows are not client-editable and stay
      // at their original positions. Existing selected menu rows are replaced
      // in place; newly selected rows are appended.
      const merged = mergePlanLineItems(currentLines, updatedMenuLines);
      const totals = computeQuoteTotals(merged, inquiry.fees, inquiry.discounts);
      const issued = hasIssuedQuote(inquiry);
      const [updated] = await tx.update(cateringInquiriesTable).set({
        lineItems: merged,
        eventDate: proposed.eventDate,
        eventTime: proposed.eventTime,
        guestCount: proposed.guestCount,
        venueAddress: proposed.venueAddress,
        menuNotes: proposed.menuNotes,
        subtotal: totals.subtotal.toFixed(2),
        feesTotal: totals.feesTotal.toFixed(2),
        discountsTotal: totals.discountsTotal.toFixed(2),
        total: totals.total.toFixed(2),
        ...(issued ? { quoteToken: null, quoteIssuedAt: null, quoteExpiresAt: null } : {}),
        updatedAt: now,
      }).where(and(
        eq(cateringInquiriesTable.id, id),
        isNull(cateringInquiriesTable.quoteAcceptedAt),
        isNull(cateringInquiriesTable.squareInvoiceId),
        sql`${cateringInquiriesTable.status} IN ('inquiry', 'quoted')`,
      )).returning();
      if (!updated) return "not-editable" as const;
      const [reviewed] = await tx.update(cateringPlanRevisionsTable)
        .set({ status: "applied", reviewedAt: now })
        .where(and(
          eq(cateringPlanRevisionsTable.id, revisionId),
          eq(cateringPlanRevisionsTable.status, "pending"),
        )).returning();
      if (!reviewed) throw new Error("Plan revision was reviewed concurrently");
      return "ok" as const;
    });
    if (outcome !== "ok") {
      const status = outcome === "not-found" || outcome === "revision-not-found" ? 404
        : 409;
      res.status(status).json({ error: outcome === "conflict"
        ? "Inquiry changed since this plan was submitted; review it against the current quote"
        : outcome === "catalog-changed"
          ? "Menu availability or pricing changed since submission; reprice the proposal before applying"
        : outcome === "already-reviewed" ? "Revision has already been reviewed"
          : outcome === "not-editable" ? "This inquiry can no longer be changed"
            : "Inquiry or revision not found" });
      return;
    }
    res.json({ ok: true });
    // A successful review is committed before notification; email failure must
    // not undo the decision or cause a client retry to review it twice.
    void (async () => {
      const [recipient] = await db.select({
        clientEmail: cateringInquiriesTable.clientEmail,
        clientName: cateringInquiriesTable.clientName,
      }).from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
      if (!recipient?.clientEmail?.trim()) return;
      const applied = body.action === "apply";
      const result = await sendMail({
        to: recipient.clientEmail.trim(),
        subject: applied ? "Your catering plan changes were reviewed" : "Update on your catering plan suggestions",
        text: applied
          ? `Hi ${recipient.clientName},\n\nWe've applied your suggested catering plan changes to your inquiry. Our team will confirm any updated pricing and send you a revised quote. Please don't use an earlier quote link to accept the revised plan.\n\n— dash by Hollywood East Cafe`
          : `Hi ${recipient.clientName},\n\nWe've reviewed your catering plan suggestions. We couldn't apply them as submitted; please contact our team so we can discuss the next steps.\n\n— dash by Hollywood East Cafe`,
      });
      if (!result.ok) req.log.warn({ error: result.error }, "Plan review customer email failed");
    })().catch((err) => req.log.warn({ err }, "Plan review customer email failed"));
  } catch (err) {
    req.log.error({ err }, "Failed to review catering plan revision");
    res.status(500).json({ error: "Failed to review plan revision" });
  }
});

export default router;