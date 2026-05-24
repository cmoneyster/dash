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
  bytesBase64: string;
  createdAt: string;
};

function authHeaders(): Record<string, string> {
  const token = getAdminToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Deliver ESC/POS bytes to a Star printer via WebPRNT.
 *
 * The printer must have HTTPS enabled and the browser must have accepted the
 * printer's self-signed certificate (visit https://<ip> once to trust it).
 *
 * If HTTPS fails for a network reason (e.g. cert not yet trusted) the error
 * message will guide the operator to the trust URL.
 */
async function deliverViaWebPrnt(job: QueuedJob): Promise<void> {
  const requestXml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<StarWebPRNT:Request Version="1.00" xmlns:StarWebPRNT="http://www.star-m.jp/StarWebPRNT/V1.00/">` +
    `<PrintData><Printer>` +
    `<RawData encoding="Base64">${job.bytesBase64}</RawData>` +
    `</Printer></PrintData>` +
    `</StarWebPRNT:Request>`;

  let response: Response;
  try {
    response = await fetch(`https://${job.lanIp}/StarWebPRNT/SendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: `job-${job.id}-${Date.now()}`,
        timeout: 10000,
        encoding: "StarPRNT",
        passCode: "",
        request: requestXml,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Common failure: browser blocked the fetch because the cert isn't trusted.
    const certHint = msg.toLowerCase().includes("failed to fetch") || msg.toLowerCase().includes("network")
      ? ` — visit https://${job.lanIp} in this browser and accept the printer's certificate, then retry.`
      : "";
    throw new Error(`WebPRNT fetch error: ${msg}${certHint}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`WebPRNT HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  const status = typeof result.status === "string" ? result.status : "";
  // Success indicators vary by firmware. Accept anything that isn't an explicit error.
  const errorStatuses = ["PrinterHoldingError", "PrinterError", "PrintDataError", "PrinterUnderline"];
  if (errorStatuses.includes(status)) {
    throw new Error(`Printer reported error: ${status}`);
  }
}

type UsePrintAgentOptions = {
  /** Set false to stop the polling loop without unmounting the hook. */
  enabled?: boolean;
  /** Override the delivery function (e.g. for non-Star printers). */
  deliver?: (job: QueuedJob) => Promise<void>;
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

            await deliverRef.current(job);

            await apiPost(`/api/print-agent/jobs/${job.id}/complete`);

            const result: AgentJobResult = {
              jobId: job.id,
              printerId: job.printerId,
              jobType: job.jobType,
              lanIp: job.lanIp,
              deliveredAt: new Date(),
              ok: true,
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
