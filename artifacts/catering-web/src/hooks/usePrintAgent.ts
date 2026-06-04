/**
 * Browser-based WebPRNT delivery hook.
 *
 * Polls the server for queued LAN print jobs every 2 seconds, claims
 * each one, and delivers the rendered WebPRNT XML to the printer via
 * Star's HTTP API (`POST https://<printer-ip>/StarWebPRNT/SendMessage`).
 *
 * The server renders the ESC/POS payload into WebPRNT XML at claim time
 * so the browser only needs to forward it — no rendering happens here.
 *
 * SETUP: Visit https://<printer-ip>/StarWebPRNT/SendMessage in the browser
 * on the same device and accept the printer's self-signed TLS cert once.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { getAdminToken } from "@/components/AdminGuard";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const POLL_INTERVAL_MS = 2_000;

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
  history: AgentJobResult[];
  successCount: number;
  failCount: number;
  lastError: string | null;
};

type QueuedJob = {
  id: number;
  printerId: number;
  jobType: string;
  lanIp: string;
};

type ClaimResponse = {
  webPrntXml: string;
  lanIp: string;
  jobType: string;
  printerId: number;
};

async function deliverToprinter(lanIp: string, xml: string): Promise<void> {
  const url = `https://${lanIp}/StarWebPRNT/SendMessage`;
  const body = JSON.stringify({
    requestId: `job-${Date.now()}`,
    timeout: 10_000,
    encoding: "utf-8",
    passCode: "",
    request: xml,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Printer returned ${res.status}: ${text.slice(0, 200)}`);
  }
}

export function usePrintAgent(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options;

  const [state, setState] = useState<PrintAgentState>({
    status: "idle",
    history: [],
    successCount: 0,
    failCount: 0,
    lastError: null,
  });

  const loopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);

  const authHeader = useCallback((): Record<string, string> => {
    const token = getAdminToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const deliverJob = useCallback(async (job: QueuedJob): Promise<void> => {
    if (!mountedRef.current) return;
    setState((s) => ({ ...s, status: "delivering" }));

    let claimData: ClaimResponse | null = null;
    try {
      const claimRes = await fetch(`${BASE}/api/print-agent/jobs/${job.id}/claim`, {
        method: "POST",
        headers: authHeader(),
      });
      if (!claimRes.ok) return;
      claimData = await claimRes.json();
    } catch {
      return;
    }

    if (!claimData) return;

    const { webPrntXml, lanIp } = claimData;
    let ok = false;
    let errorMsg: string | undefined;

    try {
      await deliverToprinter(lanIp, webPrntXml);
      ok = true;
      await fetch(`${BASE}/api/print-agent/jobs/${job.id}/complete`, {
        method: "POST",
        headers: authHeader(),
      });
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      await fetch(`${BASE}/api/print-agent/jobs/${job.id}/fail`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ error: errorMsg }),
      }).catch(() => {});
    }

    const result: AgentJobResult = {
      jobId: job.id,
      printerId: job.printerId,
      jobType: job.jobType,
      lanIp,
      deliveredAt: new Date(),
      ok,
      error: errorMsg,
    };

    if (mountedRef.current) {
      setState((s) => ({
        ...s,
        history: [result, ...s.history].slice(0, 20),
        successCount: s.successCount + (ok ? 1 : 0),
        failCount: s.failCount + (ok ? 0 : 1),
        lastError: ok ? s.lastError : (errorMsg ?? null),
      }));
    }
  }, [authHeader]);

  const poll = useCallback(async () => {
    if (!mountedRef.current || !enabled) return;

    const token = getAdminToken();
    if (!token) return;

    setState((s) => ({ ...s, status: "polling" }));

    // Discover which printers have queued jobs without fetching all jobs at once.
    // Using the unfiltered endpoint returns one entry per job so we can group by
    // printerId — the server already caps the result at 10 rows.
    let jobs: QueuedJob[] = [];
    try {
      const res = await fetch(`${BASE}/api/print-agent/queued`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`queue poll ${res.status}`);
      jobs = await res.json();
    } catch {
      if (mountedRef.current) setState((s) => ({ ...s, status: "idle" }));
      return;
    }

    if (jobs.length === 0) {
      if (mountedRef.current) setState((s) => ({ ...s, status: "idle" }));
      return;
    }

    // Collect unique printer IDs in the order they appear (oldest job first).
    const seenPrinters = new Set<number>();
    const printerIds: number[] = [];
    for (const job of jobs) {
      if (!seenPrinters.has(job.printerId)) {
        seenPrinters.add(job.printerId);
        printerIds.push(job.printerId);
      }
    }

    // Process each printer serially: drain all its queued jobs before moving
    // to the next printer. This prevents two tabs from sending overlapping
    // requests to the same physical printer in the same poll cycle.
    for (const pid of printerIds) {
      if (!mountedRef.current) return;

      // Fetch the full queue for this printer so we know how many jobs to run.
      let printerJobs: QueuedJob[] = [];
      try {
        const res = await fetch(
          `${BASE}/api/print-agent/queued?printerId=${pid}`,
          { headers: authHeader() },
        );
        if (!res.ok) continue;
        printerJobs = await res.json();
      } catch {
        continue;
      }

      for (const job of printerJobs) {
        if (!mountedRef.current) return;
        await deliverJob(job);
      }
    }

    if (mountedRef.current) setState((s) => ({ ...s, status: "idle" }));
  }, [enabled, authHeader, deliverJob]);

  useEffect(() => {
    if (!enabled) return;
    mountedRef.current = true;
    runningRef.current = false;

    const tick = async () => {
      if (!mountedRef.current) return;
      if (!runningRef.current) {
        runningRef.current = true;
        try { await poll(); } finally { runningRef.current = false; }
      }
      if (mountedRef.current) {
        loopRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    loopRef.current = setTimeout(tick, 0);

    return () => {
      mountedRef.current = false;
      if (loopRef.current != null) clearTimeout(loopRef.current);
    };
  }, [enabled, poll]);

  return state;
}
