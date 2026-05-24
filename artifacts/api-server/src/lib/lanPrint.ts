/**
 * LAN direct-print via raw TCP (port 9100).
 *
 * Star TSP-series printers expose a raw-socket interface on port 9100.
 * We open a TCP connection, write the ESC/POS bytes, and close — the
 * printer interprets and prints them exactly as it would via CloudPRNT.
 *
 * NOTE: This module is only used by the admin test-lan server-side route,
 * which is useful when the API server itself is on the same LAN as the printer
 * (e.g. local dev). For cloud-hosted deployments the server cannot reach LAN
 * printer IPs — use the browser-based print agent (`/api/print-agent/*`) instead.
 */

import * as net from "net";

/** Send raw bytes to a Star printer on port 9100. Resolves when the socket closes cleanly. */
export async function sendViaLanTcp(
  lanIp: string,
  bytes: Buffer,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(
      () => done(new Error(`LAN print timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );

    socket.on("error", done);
    socket.on("close", () => done());

    socket.connect(9100, lanIp, () => {
      socket.write(bytes, (writeErr) => {
        if (writeErr) { done(writeErr); return; }
        socket.end();
      });
    });
  });
}
