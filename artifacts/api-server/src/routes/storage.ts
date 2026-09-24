import { Router, type IRouter, type Request, type Response } from "express";
import { getObject, ObjectNotFoundError } from "../lib/objectStorage";

const router: IRouter = Router();

router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const object = await getObject(`/objects/${wildcardPath}`);
    res.setHeader("Content-Type", object.contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    if (object.size != null) res.setHeader("Content-Length", String(object.size));
    object.body.on("error", (err) => {
      req.log.error({ err }, "Error streaming object");
      res.destroy(err);
    });
    object.body.pipe(res);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
