import { Router, type IRouter } from "express";
import { snapshot } from "../lib/idle-metrics";

const router: IRouter = Router();

router.get("/admin/idle-activity", (_req, res) => {
  res.json(snapshot());
});

export default router;
