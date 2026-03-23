import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";

const SECRET = process.env.SESSION_SECRET ?? "fallback-dev-secret";
const TOKEN_PAYLOAD = "dash-admin-authenticated";

export function generateAdminToken(): string {
  return createHmac("sha256", SECRET).update(TOKEN_PAYLOAD).digest("hex");
}

export function validateAdminToken(token: string): boolean {
  const expected = generateAdminToken();
  try {
    return timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token || !validateAdminToken(token)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
