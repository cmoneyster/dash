import { Router } from "express";

const router = Router();

/**
 * GET /api/print-agent/install.sh
 *
 * Public (no auth) — returns a self-contained shell agent script with the
 * server URL and admin token baked in as defaults. Designed to be downloaded
 * to /root/print-agent.sh on a GL.iNet (OpenWrt) router.
 *
 * All API calls use ?token= query params instead of Authorization headers
 * because this router's busybox wget does not support --header.
 *
 * Query params:
 *   token  - admin Bearer token to embed in the script
 */
router.get("/print-agent/install.sh", (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  const server = `${req.protocol}://${req.get("host")}`;

  if (!token) {
    res.status(400).type("text/plain").send("Missing ?token= query parameter\n");
    return;
  }

  if (!/^[0-9a-zA-Z+/=_-]{8,}$/.test(token)) {
    res.status(400).type("text/plain").send("Invalid token format\n");
    return;
  }

  const script = `#!/bin/sh
# Hollywood East Catering — Print Agent
# Polls the server for queued print jobs and delivers raw ESC/POS bytes
# to Star thermal printers via TCP port 9100.
# Runs on GL.iNet / OpenWrt with busybox wget + nc.
# Works for ALL printers with a LAN IP configured in Admin.
#
# Uses ?token= query params — no --header needed (busybox wget compatible).
#
# Usage: (trap '' HUP; sh /root/print-agent.sh > /var/log/print-agent.log 2>&1) &

# Ignore SIGHUP so the process survives SSH disconnect
trap '' HUP

SERVER="\${PRINT_AGENT_SERVER:-${server}}"
TOKEN="\${PRINT_AGENT_TOKEN:-${token}}"
INTERVAL="\${PRINT_AGENT_INTERVAL:-5}"
TMPFILE=/tmp/print_agent_job.bin

log() { logger -t print-agent "\$1"; echo "\$(date) \$1"; }

if [ -z "\$TOKEN" ]; then
  log "ERROR: PRINT_AGENT_TOKEN is not set"
  exit 1
fi
if [ -z "\$SERVER" ]; then
  log "ERROR: PRINT_AGENT_SERVER is not set"
  exit 1
fi

HEARTBEAT_INTERVAL=30
last_heartbeat=0

log "Starting (server=\$SERVER interval=\${INTERVAL}s)"

while true; do
  # Send heartbeat every 30 s — token + serverUrl passed as query params
  # so no --header is needed (busybox wget compatible)
  now=\$(date +%s)
  if [ \$((now - last_heartbeat)) -ge \$HEARTBEAT_INTERVAL ]; then
    wget -q -T 5 -O /dev/null --post-data '' \\
      "\$SERVER/api/print-agent/heartbeat?token=\$TOKEN&serverUrl=\$SERVER" 2>/dev/null
    last_heartbeat=\$now
  fi

  # Poll for queued jobs — token in URL, no --header needed
  JOBS=\$(wget -q -T 10 -O - \\
    "\$SERVER/api/print-agent/queued?token=\$TOKEN" 2>/dev/null)

  if [ -n "\$JOBS" ] && [ "\$JOBS" != "[]" ]; then
    # Parse each job entry: {"id":N,...,"lanIp":"x.x.x.x"}
    echo "\$JOBS" | grep -o '"id":[0-9]*[^}]*"lanIp":"[^"]*"' | while IFS= read -r entry; do
      JOB_ID=\$(echo "\$entry" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
      LAN_IP=\$(echo "\$entry" | grep -o '"lanIp":"[^"]*"' | sed 's/"lanIp":"//;s/"//')

      [ -z "\$JOB_ID" ] || [ -z "\$LAN_IP" ] && continue

      log "Job \$JOB_ID -> \$LAN_IP:9100"

      # Fetch raw ESC/POS bytes (atomically claims the job)
      wget -q -T 15 -O "\$TMPFILE" \\
        "\$SERVER/api/print-agent/jobs/\$JOB_ID/bytes?token=\$TOKEN" 2>/dev/null

      if [ \$? -eq 0 ] && [ -s "\$TMPFILE" ]; then
        # Pipe bytes directly to the printer's TCP port 9100
        # (busybox nc has no -w flag; use timeout instead)
        timeout 10 nc "\$LAN_IP" 9100 < "\$TMPFILE" 2>/tmp/print_nc_err
        NC_STATUS=\$?
        rm -f "\$TMPFILE"

        if [ \$NC_STATUS -eq 0 ]; then
          log "Job \$JOB_ID printed OK"
          wget -q -T 10 -O /dev/null --post-data '' \\
            "\$SERVER/api/print-agent/jobs/\$JOB_ID/complete?token=\$TOKEN" 2>/dev/null
        else
          ERR_MSG=\$(cat /tmp/print_nc_err 2>/dev/null | head -c 100)
          log "Job \$JOB_ID nc failed (\$NC_STATUS): \$ERR_MSG"
          wget -q -T 10 -O /dev/null --post-data '' \\
            "\$SERVER/api/print-agent/jobs/\$JOB_ID/fail?token=\$TOKEN&error=nc+exit+\$NC_STATUS" 2>/dev/null
        fi
      else
        rm -f "\$TMPFILE"
        log "Job \$JOB_ID bytes fetch failed"
        wget -q -T 10 -O /dev/null --post-data '' \\
          "\$SERVER/api/print-agent/jobs/\$JOB_ID/fail?token=\$TOKEN&error=bytes+fetch+failed" 2>/dev/null
      fi
    done
  fi

  sleep "\$INTERVAL"
done
`;

  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Content-Disposition", "inline; filename=print-agent.sh");
  res.send(script);
});

export default router;
