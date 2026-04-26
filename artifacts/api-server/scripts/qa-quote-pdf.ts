/**
 * Manual visual QA harness for the quote PDF renderer.
 *
 * Generates a PDF for each of the five representative quote shapes called
 * out in Task #143 and writes them to /tmp/qa-quote-pdf/ for inspection.
 *
 * Usage: pnpm --filter @workspace/api-server exec tsx scripts/qa-quote-pdf.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CateringInquiry, QuoteLineItem, QuoteAdjustment } from "@workspace/db/schema";
import { renderQuotePdf } from "../src/lib/quote.js";

const OUT_DIR = "/tmp/qa-quote-pdf";

function li(over: Partial<QuoteLineItem> & Pick<QuoteLineItem, "id" | "name">): QuoteLineItem {
  return {
    id: over.id,
    menuItemId: null,
    name: over.name,
    quantity: 10,
    unitPrice: 12.5,
    notes: null,
    pricingTemplate: "per_unit",
    sizeSlot: null,
    sizeLabel: null,
    sizeServings: null,
    unit: "tray",
    servingSize: 12,
    tierApplied: null,
    priceMode: "auto",
    ...over,
  };
}

function fee(label: string, amount: number, kind: "fixed" | "percent" = "fixed"): QuoteAdjustment {
  return { id: `fee-${label}`, label, kind, amount };
}

function inquiry(over: Partial<CateringInquiry>): CateringInquiry {
  // Use `as` because CateringInquiry has many DB-only fields we don't need;
  // renderQuotePdf only reads a small subset of them.
  return {
    id: 1,
    clientName: "Jane Doe",
    clientEmail: "jane@example.com",
    clientPhone: "555-123-4567",
    organization: "Acme Corp",
    eventDate: "2026-06-15",
    guestCount: 50,
    venueAddress: "123 Main St, San Francisco, CA",
    quoteNumber: "Q-1001",
    quoteIssuedAt: new Date("2026-04-26"),
    quoteExpiresAt: new Date("2026-05-26"),
    quoteNotes: null,
    serviceMode: "drop_off",
    otdSetupFee: null,
    otdFeeWaiverThreshold: null,
    lineItems: [],
    fees: [],
    discounts: [],
    ...over,
  } as unknown as CateringInquiry;
}

async function emit(name: string, inq: CateringInquiry) {
  const buf = await renderQuotePdf(inq);
  const out = path.join(OUT_DIR, `${name}.pdf`);
  await writeFile(out, buf);
  console.log(`  wrote ${out} (${buf.length} bytes)`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  console.log("(a) short happy-path quote");
  await emit(
    "a-happy-path",
    inquiry({
      lineItems: [
        li({ id: "1", name: "Kung Pao Chicken" }),
        li({ id: "2", name: "Beef and Broccoli", quantity: 8, unitPrice: 14 }),
        li({ id: "3", name: "Vegetable Fried Rice", quantity: 6, unitPrice: 9 }),
      ],
    }),
  );

  console.log("(b) waiver active right at the page-1 boundary");
  await emit(
    "b-waived-at-boundary",
    inquiry({
      serviceMode: "on_the_dash",
      otdSetupFee: "150" as unknown as CateringInquiry["otdSetupFee"],
      otdFeeWaiverThreshold: "500" as unknown as CateringInquiry["otdFeeWaiverThreshold"],
      quoteNotes: "Please leave packaging at the side entrance.",
      fees: [fee("Service charge", 18, "percent"), fee("Delivery", 25)],
      discounts: [fee("Loyalty discount", 5, "percent")],
      lineItems: Array.from({ length: 14 }, (_, i) =>
        li({
          id: String(i + 1),
          name: `Menu Item ${i + 1}`,
          quantity: 4 + (i % 5),
          unitPrice: 9 + (i % 7),
          notes: i % 3 === 0 ? "Extra spicy please" : null,
        }),
      ),
    }),
  );

  console.log("(c) long notes (3 items, 10+ line notes)");
  const longNotes = Array.from({ length: 14 }, (_, i) =>
    `Note line ${i + 1}: please double-check the dietary restrictions list and confirm with the kitchen lead before packing the trays for departure.`,
  ).join("\n");
  await emit(
    "c-long-notes",
    inquiry({
      quoteNotes: longNotes,
      lineItems: [
        li({ id: "1", name: "Kung Pao Chicken" }),
        li({ id: "2", name: "Beef and Broccoli", quantity: 8, unitPrice: 14 }),
        li({ id: "3", name: "Vegetable Fried Rice", quantity: 6, unitPrice: 9 }),
      ],
    }),
  );

  console.log("(d) line items spill to page 2 with totals + notes + terms on page 2");
  await emit(
    "d-spill-to-page-2",
    inquiry({
      quoteNotes: "Please confirm guest count by Friday.",
      fees: [fee("Service charge", 18, "percent"), fee("Delivery", 25)],
      discounts: [fee("Repeat client", 10, "percent")],
      lineItems: Array.from({ length: 28 }, (_, i) =>
        li({
          id: String(i + 1),
          name: `Menu Item ${i + 1} with a slightly longer descriptive name`,
          quantity: 4 + (i % 6),
          unitPrice: 8 + (i % 9),
          notes: i % 4 === 0 ? "Please pack separately" : null,
        }),
      ),
    }),
  );

  console.log("(e) Chinese characters in item name and client name");
  await emit(
    "e-cjk-mixed",
    inquiry({
      clientName: "李小龙",
      organization: "好莱坞东咖啡",
      venueAddress: "北京路 123 号, 上海",
      quoteNotes: "请准时送达。Please arrive on time.\nThanks!",
      lineItems: [
        li({ id: "1", name: "宫保鸡丁 Kung Pao Chicken" }),
        li({ id: "2", name: "牛肉炒饭 Beef Fried Rice", quantity: 8, unitPrice: 14, notes: "微辣 mild spice" }),
        li({ id: "3", name: "Vegetable Spring Rolls 春卷", quantity: 24, unitPrice: 3 }),
      ],
    }),
  );

  console.log("\nAll PDFs written to", OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
