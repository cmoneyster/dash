import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { cateringInquiriesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { renderQuotePdf, publicQuoteFromInquiry } from "../lib/quote";

const router: IRouter = Router();

// JSON snapshot for the public read-only quote page
router.get("/quote/:token", async (req, res): Promise<void> => {
  try {
    const token = req.params.token;
    if (!token) { res.status(404).json({ error: "Quote not found" }); return; }
    const [inquiry] = await db
      .select()
      .from(cateringInquiriesTable)
      .where(eq(cateringInquiriesTable.quoteToken, token));
    if (!inquiry || !inquiry.quoteIssuedAt) { res.status(404).json({ error: "Quote not found" }); return; }
    if (inquiry.quoteExpiresAt && new Date(inquiry.quoteExpiresAt) < new Date()) {
      res.status(410).json({ error: "Quote has expired", expired: true });
      return;
    }
    res.json(publicQuoteFromInquiry(inquiry));
  } catch (err) {
    req.log.error({ err }, "Error fetching public quote");
    res.status(500).json({ error: "Failed to fetch quote" });
  }
});

router.get("/quote/:token/pdf", async (req, res): Promise<void> => {
  try {
    const token = req.params.token;
    if (!token) { res.status(404).json({ error: "Quote not found" }); return; }
    const [inquiry] = await db
      .select()
      .from(cateringInquiriesTable)
      .where(eq(cateringInquiriesTable.quoteToken, token));
    if (!inquiry || !inquiry.quoteIssuedAt) { res.status(404).json({ error: "Quote not found" }); return; }
    if (inquiry.quoteExpiresAt && new Date(inquiry.quoteExpiresAt) < new Date()) {
      res.status(410).json({ error: "Quote has expired" });
      return;
    }
    const pdf = await renderQuotePdf(inquiry);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${inquiry.quoteNumber ?? `quote-${inquiry.id}`}.pdf"`,
    );
    res.send(pdf);
  } catch (err) {
    req.log.error({ err }, "Error rendering public quote PDF");
    res.status(500).json({ error: "Failed to render PDF" });
  }
});

export default router;
