import { Router, type IRouter } from "express";
import { generateAdminToken, validateAdminToken } from "../lib/adminAuth";

const router: IRouter = Router();

router.get("/admin/verify", (req, res) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token || !validateAdminToken(token)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({ ok: true });
});

router.post("/admin/login", (req, res) => {
  const { password } = req.body as { password?: string };
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    req.log.error("ADMIN_PASSWORD environment variable is not set");
    res.status(500).json({ error: "Admin authentication is not configured" });
    return;
  }

  if (!password || password !== adminPassword) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  const token = generateAdminToken();
  res.json({ token });
});

export default router;
