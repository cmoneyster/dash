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
  const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  // EventSource (used by the customer-chat SSE feed) can't set
  // Authorization headers, so we also accept ?token=... as a fallback.
  // The token is the same HMAC value the header path uses, so leaking
  // it via the query string is no worse than leaking the header value.
  const queryToken = typeof req.query?.token === "string" ? req.query.token : null;
  const token = headerToken || queryToken;

  if (!token || !validateAdminToken(token)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
