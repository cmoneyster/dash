/**
 * Browser-based LAN print agent hook.
 *
 * Run this hook on any page that is on the same LAN as your printers.
 * It polls the server for queued LAN jobs every 2 seconds, atomically
 * claims each one, delivers the ESC/POS bytes to the printer's Star WebPRNT
 * endpoint, then reports success or failure back to the server.
 *
 * SETUP: Before LAN printing works, visit https://<printer-ip>/StarWebPRNT/SendMessage
 * in the browser and accept the printer's self-signed TLS certificate.
 * (Most Star printers use HTTPS on port 443 with a self-signed cert.)
 *
 * Star WebPRNT delivery format:
 *   POST https://<lanIp>/StarWebPRNT/SendMessage
 *   Content-Type: application/json
 *   Body: { requestId, timeout, encoding, passCode, request: XML }
 *
 * If you need raw-byte delivery (e.g. for older models that expose
 * cgi-bin/rawiocgi.cgi), override the `deliver` option.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { getAdminToken } from "@/components/AdminGuard";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const POLL_INTERVAL_MS = 2000;

export type AgentJobResult = {
  jobId: number;
  printerId: number;
  jobType: string;
  lanIp: string;
  deliveredAt: Date;
  ok: boolean;
  error?: string;
  /** Raw response body from the printer — useful for diagnosing silent failures. */
  printerResponse?: string;
};

export type PrintAgentStatus = "idle" | "polling" | "delivering" | "error";

export type PrintAgentState = {
  status: PrintAgentStatus;
  /** Most recent delivery results (last 20). */
  history: AgentJobResult[];
  /** Total jobs delivered successfully since mount. */
  successCount: number;
  /** Total jobs failed since mount. */
  failCount: number;
  lastError: string | null;
};

type QueuedJob = {
  id: number;
  printerId: number;
  jobType: string;
  lanIp: string;
  webPrntXml: string;
  createdAt: string;
};

function authHeaders(): Record<string, string> {
  const token = getAdminToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Deliver a StarWebPRNT XML job to a Star printer.
 *
 * The server pre-builds the StarWebPRNT high-level XML (Text, Bold,
 * CharacterExpansion, CutPaper elements) so the printer's firmware
 * interprets commands natively regardless of its language-mode setting.
 * We POST it directly with Content-Type: text/xml and parse the XML
 * response to surface any printer-reported errors.
 *
 * The printer must have HTTPS enabled and the browser must have accepted the
 * printer's self-signed certificate (visit https://<ip> once to trust it).
 */
/**
 * Returns the raw printer response body string (for diagnostic display).
 * Throws if the printer reports a failure or is unreachable.
 */
async function deliverViaWebPrnt(job: QueuedJob): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`https://${job.lanIp}/StarWebPRNT/SendMessage`, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body: job.webPrntXml,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const certHint =
      msg.toLowerCase().includes("failed to fetch") || msg.toLowerCase().includes("network")
        ? ` — visit https://${job.lanIp} in this browser and accept the printer's certificate, then retry.`
        : "";
    throw new Error(`WebPRNT fetch error: ${msg}${certHint}`);
  }

  const body = await response.text().catch(() => "");

  if (!response.ok) {
    throw new Error(`WebPRNT HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  // Parse the XML response and surface any printer-reported errors.
  // A missing or unparseable response is treated as success — some
  // firmware versions return an empty 200 body on success.
  if (body.trim()) {
    try {
      const doc = new DOMParser().parseFromString(body, "text/xml");
      const successEl = doc.querySelector("Success");
      if (successEl && successEl.textContent?.trim().toLowerCase() === "false") {
        const errorEl =
          doc.querySelector("PrinterError") ??
          doc.querySelector("ErrorCode") ??
          doc.querySelector("Error");
        const detail = errorEl?.textContent?.trim() ?? "unknown error";
        throw new Error(`Printer reported failure: ${detail}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Printer reported")) throw err;
      // XML parse errors are non-fatal — treat as success.
    }
  }

  return body;
}

type UsePrintAgentOptions = {
  /** Set false to stop the polling loop without unmounting the hook. */
  enabled?: boolean;
  /** Override the delivery function (e.g. for non-Star printers). */
  deliver?: (job: QueuedJob) => Promise<string>;
};

export function usePrintAgent(options: UsePrintAgentOptions = {}): PrintAgentState {
  const { enabled = true, deliver = deliverViaWebPrnt } = options;
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;

  const [state, setState] = useState<PrintAgentState>({
    status: "idle",
    history: [],
    successCount: 0,
    failCount: 0,
    lastError: null,
  });

  const inFlightIds = useRef<Set<number>>(new Set());
  const pollingRef = useRef(false);

  const apiPost = useCallback(async (path: string, body?: Record<string, unknown>) => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }, []);

  const poll = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    setState(s => ({ ...s, status: "polling", lastError: null }));

    try {
      const res = await fetch(`${BASE}/api/print-agent/queued`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        setState(s => ({ ...s, status: "error", lastError: `Server ${res.status}` }));
        return;
      }
      const jobs: QueuedJob[] = await res.json();
      const pending = jobs.filter((j) => !inFlightIds.current.has(j.id));

      if (pending.length === 0) {
        setState(s => ({ ...s, status: "idle" }));
        return;
      }

      setState(s => ({ ...s, status: "delivering" }));

      await Promise.all(
        pending.map(async (job) => {
          inFlightIds.current.add(job.id);
          try {
            const claimRes = await apiPost(`/api/print-agent/jobs/${job.id}/claim`);
            if (claimRes.status === 409) {
              // Already claimed by CloudPRNT or another agent instance — skip.
              return;
            }
            if (!claimRes.ok) throw new Error(`Claim failed: ${claimRes.status}`);

            const printerResponse = await deliverRef.current(job);

            await apiPost(`/api/print-agent/jobs/${job.id}/complete`, { printerResponse });

            const result: AgentJobResult = {
              jobId: job.id,
              printerId: job.printerId,
              jobType: job.jobType,
              lanIp: job.lanIp,
              deliveredAt: new Date(),
              ok: true,
              printerResponse: printerResponse || undefined,
            };
            setState(s => ({
              ...s,
              history: [result, ...s.history].slice(0, 20),
              successCount: s.successCount + 1,
            }));
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            try {
              await apiPost(`/api/print-agent/jobs/${job.id}/fail`, { error: errMsg });
            } catch { /* fire and forget */ }

            const result: AgentJobResult = {
              jobId: job.id,
              printerId: job.printerId,
              jobType: job.jobType,
              lanIp: job.lanIp,
              deliveredAt: new Date(),
              ok: false,
              error: errMsg,
            };
            setState(s => ({
              ...s,
              history: [result, ...s.history].slice(0, 20),
              failCount: s.failCount + 1,
              lastError: errMsg,
            }));
          } finally {
            inFlightIds.current.delete(job.id);
          }
        }),
      );

      setState(s => ({ ...s, status: s.failCount > 0 && s.successCount === 0 ? "error" : "idle" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState(s => ({ ...s, status: "error", lastError: msg }));
    } finally {
      pollingRef.current = false;
    }
  }, [apiPost]);

  useEffect(() => {
    if (!enabled) return;
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, poll]);

  return state;
}
