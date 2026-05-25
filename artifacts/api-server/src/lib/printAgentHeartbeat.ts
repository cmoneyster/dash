/**
 * Shared in-memory store for router-agent heartbeat timestamps.
 * Keyed by admin bearer token — survives server restarts only while
 * the process is alive (acceptable: the agent re-pings every 30 s).
 */
export interface HeartbeatEntry {
  lastSeenAt: Date;
  serverUrl: string;
}

export const heartbeatStore = new Map<string, HeartbeatEntry>();
