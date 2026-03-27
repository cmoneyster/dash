// ejointech HTTP SMS API integration
// Docs: https://view.publitas.com/p222-14110/ejoin-gateway-http-sms-api-v1-2/page/1
// Gateway URL format: http://<host>:<port>  (no trailing slash)
// API endpoint: GET /default/en_US/send_sms.html?cmd=sms_send&num=...&smsc=0&msg=...&user=...&pass=...

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function getConfig(): { baseUrl: string; user: string; pass: string } | null {
  const baseUrl = process.env.EJOIN_GATEWAY_URL?.trim();
  const user    = process.env.EJOIN_USER?.trim();
  const pass    = process.env.EJOIN_PASS?.trim();
  if (!baseUrl || !user || !pass) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), user, pass };
}

export function isEjoinConfigured(): boolean {
  return getConfig() !== null;
}

export async function sendSmsViaEjoin(to: string, message: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg) throw new Error("ejointech gateway not configured");

  const normalized = normalizePhone(to);

  const params = new URLSearchParams({
    cmd:  "sms_send",
    num:  normalized,
    smsc: "0",           // auto-select SIM port
    msg:  message,
    user: cfg.user,
    pass: cfg.pass,
  });

  const url = `${cfg.baseUrl}/default/en_US/send_sms.html?${params.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`ejointech gateway returned HTTP ${response.status}`);
  }

  const body = (await response.text()).trim().toLowerCase();
  // The gateway returns "ok" on success, "fail" on error
  if (body !== "ok" && !body.includes("ok")) {
    throw new Error(`ejointech gateway rejected message: ${body}`);
  }

  console.info(`[ejoin] SMS sent to ${normalized}`);
}
