// Test allowlist for development. When SMS_TEST_NUMBERS is set (comma-
// separated phone numbers), texts are only sent to — and inbound texts
// only ingested from — those numbers; everything else is logged and
// dropped. Leave it unset in production (no restriction).

function lastTenDigits(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

export function getSmsTestNumbers(): Set<string> | null {
  const raw = process.env.SMS_TEST_NUMBERS?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map(lastTenDigits).filter(Boolean));
}

export function isAllowedBySmsTestNumbers(phone: string): boolean {
  const allowed = getSmsTestNumbers();
  return !allowed || allowed.has(lastTenDigits(phone));
}
