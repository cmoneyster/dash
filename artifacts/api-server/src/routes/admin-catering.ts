import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { cateringInquiriesTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();

const VALID_STATUSES = ["inquiry", "quoted", "confirmed", "completed", "cancelled"];

// List all catering inquiries
router.get("/admin/catering", async (req, res) => {
  try {
    const inquiries = await db
      .select()
      .from(cateringInquiriesTable)
      .orderBy(desc(cateringInquiriesTable.createdAt));
    res.json(inquiries);
  } catch (err) {
    req.log.error({ err }, "Error listing catering inquiries");
    res.status(500).json({ error: "Failed to fetch inquiries" });
  }
});

// Get a single inquiry
router.get("/admin/catering/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) return res.status(404).json({ error: "Inquiry not found" });
    res.json(inquiry);
  } catch (err) {
    req.log.error({ err }, "Error fetching catering inquiry");
    res.status(500).json({ error: "Failed to fetch inquiry" });
  }
});

// Create a new catering inquiry
router.post("/admin/catering", async (req, res) => {
  try {
    const {
      clientName, clientEmail, clientPhone, organization,
      eventDate, guestCount, venueAddress, menuNotes, adminNotes, status,
    } = req.body as {
      clientName: string;
      clientEmail?: string;
      clientPhone?: string;
      organization?: string;
      eventDate?: string;
      guestCount?: number;
      venueAddress?: string;
      menuNotes?: string;
      adminNotes?: string;
      status?: string;
    };

    if (!clientName?.trim()) {
      res.status(400).json({ error: "Client name is required" });
      return;
    }

    const [inquiry] = await db
      .insert(cateringInquiriesTable)
      .values({
        clientName: clientName.trim(),
        clientEmail: clientEmail?.trim() || null,
        clientPhone: clientPhone?.trim() || null,
        organization: organization?.trim() || null,
        eventDate: eventDate?.trim() || null,
        guestCount: guestCount ?? null,
        venueAddress: venueAddress?.trim() || null,
        menuNotes: menuNotes?.trim() || null,
        adminNotes: adminNotes?.trim() || null,
        status: VALID_STATUSES.includes(status ?? "") ? status! : "inquiry",
      })
      .returning();

    res.status(201).json(inquiry);
  } catch (err) {
    req.log.error({ err }, "Error creating catering inquiry");
    res.status(500).json({ error: "Failed to create inquiry" });
  }
});

// Update a catering inquiry
router.put("/admin/catering/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const {
      clientName, clientEmail, clientPhone, organization,
      eventDate, guestCount, venueAddress, menuNotes, adminNotes, status,
    } = req.body as Record<string, any>;

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (clientName !== undefined) updates.clientName = clientName.trim();
    if (clientEmail !== undefined) updates.clientEmail = clientEmail.trim() || null;
    if (clientPhone !== undefined) updates.clientPhone = clientPhone.trim() || null;
    if (organization !== undefined) updates.organization = organization.trim() || null;
    if (eventDate !== undefined) updates.eventDate = eventDate.trim() || null;
    if (guestCount !== undefined) updates.guestCount = guestCount === "" || guestCount === null ? null : parseInt(String(guestCount));
    if (venueAddress !== undefined) updates.venueAddress = venueAddress.trim() || null;
    if (menuNotes !== undefined) updates.menuNotes = menuNotes.trim() || null;
    if (adminNotes !== undefined) updates.adminNotes = adminNotes.trim() || null;
    if (status !== undefined && VALID_STATUSES.includes(status)) updates.status = status;

    const [updated] = await db
      .update(cateringInquiriesTable)
      .set(updates)
      .where(eq(cateringInquiriesTable.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: "Inquiry not found" });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating catering inquiry");
    res.status(500).json({ error: "Failed to update inquiry" });
  }
});

// Delete a catering inquiry
router.delete("/admin/catering/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [deleted] = await db
      .delete(cateringInquiriesTable)
      .where(eq(cateringInquiriesTable.id, id))
      .returning();
    if (!deleted) return res.status(404).json({ error: "Inquiry not found" });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error deleting catering inquiry");
    res.status(500).json({ error: "Failed to delete inquiry" });
  }
});

export default router;
