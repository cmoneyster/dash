import { Router } from "express";

const router = Router();

/**
 * GET /api/print-agent/install.sh
 *
 * Public (no auth) — returns a self-contained shell script that installs
 * the router agent on a GL.iNet (OpenWrt) device.
 *
 * Query params:
 *   token   - admin token to embed in UCI config
 *   server  - server base URL (e.g. https://my-app.replit.app)
 */
router.get("/print-agent/install.sh", (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const server = typeof req.query.server === "string" ? req.query.server : "";

  const agentScript = `#!/bin/sh
# Hollywood East Catering — Print Agent
# Polls the server for queued print jobs and delivers raw ESC/POS bytes
# to Star thermal printers via TCP port 9100.
# Runs on GL.iNet / OpenWrt with busybox wget + nc.

SERVER="\${PRINT_AGENT_SERVER:-${server}}"
TOKEN="\${PRINT_AGENT_TOKEN:-${token}}"
INTERVAL="\${PRINT_AGENT_INTERVAL:-5}"
TMPFILE=/tmp/print_agent_job.bin

log() { logger -t print-agent "\$1"; }

if [ -z "\$TOKEN" ]; then
  log "ERROR: PRINT_AGENT_TOKEN is not set"
  exit 1
fi
if [ -z "\$SERVER" ]; then
  log "ERROR: PRINT_AGENT_SERVER is not set"
  exit 1
fi

log "Starting (server=\$SERVER interval=\${INTERVAL}s)"

while true; do
  JOBS=\$(wget -q -T 10 -O - \\
    --header "Authorization: Bearer \$TOKEN" \\
    "\$SERVER/api/print-agent/queued" 2>/dev/null)

  if [ -n "\$JOBS" ] && [ "\$JOBS" != "[]" ]; then
    echo "\$JOBS" | grep -o '"id":[0-9]*[^}]*"lanIp":"[^"]*"' | while IFS= read -r entry; do
      JOB_ID=\$(echo "\$entry" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
      LAN_IP=\$(echo "\$entry" | grep -o '"lanIp":"[^"]*"' | sed 's/"lanIp":"//;s/"//')

      [ -z "\$JOB_ID" ] || [ -z "\$LAN_IP" ] && continue

      log "Job \$JOB_ID -> \$LAN_IP:9100"

      wget -q -T 15 -O "\$TMPFILE" \\
        --header "Authorization: Bearer \$TOKEN" \\
        "\$SERVER/api/print-agent/jobs/\$JOB_ID/bytes" 2>/dev/null

      if [ \$? -eq 0 ] && [ -s "\$TMPFILE" ]; then
        nc -w 3 "\$LAN_IP" 9100 < "\$TMPFILE" 2>/tmp/print_nc_err
        NC_STATUS=\$?
        rm -f "\$TMPFILE"

        if [ \$NC_STATUS -eq 0 ]; then
          log "Job \$JOB_ID printed OK"
          wget -q -T 10 -O /dev/null \\
            --post-data '{}' \\
            --header "Content-Type: application/json" \\
            --header "Authorization: Bearer \$TOKEN" \\
            "\$SERVER/api/print-agent/jobs/\$JOB_ID/complete" 2>/dev/null
        else
          ERR_MSG=\$(cat /tmp/print_nc_err 2>/dev/null | head -c 200)
          log "Job \$JOB_ID nc failed (\$NC_STATUS): \$ERR_MSG"
          wget -q -T 10 -O /dev/null \\
            --post-data "{\\"error\\":\\"nc exit \$NC_STATUS\\"}" \\
            --header "Content-Type: application/json" \\
            --header "Authorization: Bearer \$TOKEN" \\
            "\$SERVER/api/print-agent/jobs/\$JOB_ID/fail" 2>/dev/null
        fi
      else
        rm -f "\$TMPFILE"
        log "Job \$JOB_ID bytes fetch failed"
        wget -q -T 10 -O /dev/null \\
          --post-data '{"error":"bytes fetch failed"}' \\
          --header "Content-Type: application/json" \\
          --header "Authorization: Bearer \$TOKEN" \\
          "\$SERVER/api/print-agent/jobs/\$JOB_ID/fail" 2>/dev/null
      fi
    done
  fi

  sleep "\$INTERVAL"
done
`;

  const initScript = `#!/bin/sh /etc/rc.common
# OpenWrt init.d service for print-agent
# Install: chmod +x /etc/init.d/print-agent
#          /etc/init.d/print-agent enable
#          /etc/init.d/print-agent start

START=99
STOP=10
USE_PROCD=1

start_service() {
  local server token interval
  server=\$(uci -q get print-agent.main.server)
  token=\$(uci -q get print-agent.main.token)
  interval=\$(uci -q get print-agent.main.interval || echo "5")

  procd_open_instance
  procd_set_param command /usr/bin/print-agent.sh
  procd_set_param env \\
    PRINT_AGENT_SERVER="\$server" \\
    PRINT_AGENT_TOKEN="\$token" \\
    PRINT_AGENT_INTERVAL="\$interval"
  procd_set_param respawn 3600 5 0
  procd_set_param stdout 1
  procd_set_param stderr 1
  procd_close_instance
}
`;

  const installSh = `#!/bin/sh
# Install the print-agent on a GL.iNet (OpenWrt) router
# Usage: wget -qO- 'https://SERVER/api/print-agent/install.sh?token=TOKEN' | sh

set -e

SERVER="${server}"
TOKEN="${token}"

if [ -z "$SERVER" ] || [ -z "$TOKEN" ]; then
  echo "ERROR: install.sh must be fetched with ?server=...&token=... query params"
  exit 1
fi

echo "==> Installing print-agent..."

# Write the polling agent
cat > /usr/bin/print-agent.sh << 'AGENT_EOF'
${agentScript}
AGENT_EOF
chmod +x /usr/bin/print-agent.sh

# Write the init.d service
cat > /etc/init.d/print-agent << 'INIT_EOF'
${initScript}
INIT_EOF
chmod +x /etc/init.d/print-agent

# Configure via UCI
uci -q delete print-agent.main 2>/dev/null || true
uci set print-agent.main=config
uci set print-agent.main.server="$SERVER"
uci set print-agent.main.token="$TOKEN"
uci set print-agent.main.interval="5"
uci commit print-agent

# Enable and (re)start
/etc/init.d/print-agent enable
/etc/init.d/print-agent restart 2>/dev/null || /etc/init.d/print-agent start

echo "==> print-agent installed and started."
echo "    Logs: logread -f | grep print-agent"
echo "    Stop: /etc/init.d/print-agent stop"
`;

  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Content-Disposition", "inline; filename=install.sh");
  res.send(installSh);
});

export default router;
