import { Router, type IRouter } from "express";
import { sendSms } from "../lib/sms";

const router: IRouter = Router();

interface VerifyEntry {
  code: string;
  expiresAt: number;
  attempts: number;
}

// In-memory store: normalizedPhone → entry
const store = new Map<string, VerifyEntry>();

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function randomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt < now) store.delete(key);
  }
}, 60_000);

// POST /api/verify/send
router.post("/verify/send", async (req, res): Promise<void> => {
  try {
    const { phone } = req.body as { phone?: string };
    if (!phone) {
      res.status(400).json({ error: "phone is required" });
      return;
    }

    const normalized = normalizePhone(phone);
    if (normalized.replace(/\D/g, "").length < 10) {
      res.status(400).json({ error: "Invalid phone number" });
      return;
    }

    const code = randomCode();
    store.set(normalized, { code, expiresAt: Date.now() + 10 * 60_000, attempts: 0 });

    await sendSms(normalized, `Your dash by Hollywood East Cafe verification code is: ${code}. It expires in 10 minutes.`);

    res.json({ sent: true });
  } catch (err) {
    req.log.error({ err }, "Error sending verification code");
    res.status(500).json({ error: "Failed to send verification code" });
  }
});

// POST /api/verify/confirm
router.post("/verify/confirm", (req, res): void => {
  try {
    const { phone, code } = req.body as { phone?: string; code?: string };
    if (!phone || !code) {
      res.status(400).json({ error: "phone and code are required" });
      return;
    }

    const normalized = normalizePhone(phone);
    const entry = store.get(normalized);

    if (!entry) {
      res.status(400).json({ error: "No verification pending for this number. Please request a new code." });
      return;
    }
    if (Date.now() > entry.expiresAt) {
      store.delete(normalized);
      res.status(400).json({ error: "Code has expired. Please request a new one." });
      return;
    }

    entry.attempts += 1;
    if (entry.attempts > 5) {
      store.delete(normalized);
      res.status(429).json({ error: "Too many attempts. Please request a new code." });
      return;
    }

    if (entry.code !== code.trim()) {
      res.status(400).json({ error: "Incorrect code. Please try again." });
      return;
    }

    store.delete(normalized);
    res.json({ verified: true });
  } catch (err) {
    req.log.error({ err }, "Error confirming verification code");
    res.status(500).json({ error: "Failed to confirm verification code" });
  }
});

export default router;
