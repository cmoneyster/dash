import { Router, type IRouter } from "express";
import multer from "multer";
import sharp from "sharp";
import { db } from "@workspace/db";
import { imagesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { uploadObject } from "../lib/objectStorage";
import { requireAdminAuth } from "../lib/adminAuth";

const router: IRouter = Router();
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

const TARGET_WIDTH = 800;
const TARGET_HEIGHT = 600;

const HERO_WIDTH = 1920;
const HERO_HEIGHT = 1080;

router.use("/admin/images", requireAdminAuth);

router.get("/admin/images", async (req, res) => {
  try {
    const images = await db
      .select()
      .from(imagesTable)
      .orderBy(imagesTable.uploadedAt);
    res.json(images.reverse());
  } catch (err) {
    req.log.error({ err }, "Error listing images");
    res.status(500).json({ error: "Failed to list images" });
  }
});

router.post(
  "/admin/images/upload",
  upload.single("image"),
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "No image file provided" });
      return;
    }

    try {
      const processed = await sharp(req.file.buffer)
        .resize(TARGET_WIDTH, TARGET_HEIGHT, {
          fit: "cover",
          position: "centre",
        })
        .jpeg({ quality: 90, progressive: true })
        .toBuffer();

      const objectPath = await uploadObject(processed, "image/jpeg");
      const servingUrl = `/api/storage${objectPath}`;

      const originalName = req.file.originalname.replace(/\.[^/.]+$/, "") + ".jpg";

      const [image] = await db
        .insert(imagesTable)
        .values({
          filename: originalName,
          objectPath,
          servingUrl,
          mimeType: "image/jpeg",
        })
        .returning();

      res.status(201).json(image);
    } catch (err) {
      req.log.error({ err }, "Error uploading image");
      res.status(500).json({ error: "Failed to upload image" });
    }
  }
);

router.post(
  "/admin/images/upload-hero",
  upload.single("image"),
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "No image file provided" });
      return;
    }

    try {
      const processed = await sharp(req.file.buffer)
        .resize(HERO_WIDTH, HERO_HEIGHT, {
          fit: "cover",
          position: "centre",
        })
        .jpeg({ quality: 92, progressive: true })
        .toBuffer();

      const objectPath = await uploadObject(processed, "image/jpeg");
      const servingUrl = `/api/storage${objectPath}`;

      res.status(201).json({ servingUrl });
    } catch (err) {
      req.log.error({ err }, "Error uploading hero image");
      res.status(500).json({ error: "Failed to upload hero image" });
    }
  }
);

router.delete("/admin/images/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid image ID" });
    return;
  }

  try {
    await db.delete(imagesTable).where(eq(imagesTable.id, id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Error deleting image");
    res.status(500).json({ error: "Failed to delete image" });
  }
});

export default router;
