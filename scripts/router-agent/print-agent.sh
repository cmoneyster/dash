#!/bin/sh
# Hollywood East Catering — Print Agent
# Polls the server for queued print jobs and delivers raw ESC/POS bytes
# to Star thermal printers via TCP port 9100.
# Designed for GL.iNet / OpenWrt with busybox wget + nc.
#
# Configuration (set via UCI or environment variables):
#   PRINT_AGENT_SERVER   - base URL of the catering server (no trailing slash)
#   PRINT_AGENT_TOKEN    - admin Bearer token
#   PRINT_AGENT_INTERVAL - poll interval in seconds (default: 5)
#
# Install via the admin UI: Admin → Printers → Router Agent Setup

SERVER="${PRINT_AGENT_SERVER:-}"
TOKEN="${PRINT_AGENT_TOKEN:-}"
INTERVAL="${PRINT_AGENT_INTERVAL:-5}"
TMPFILE=/tmp/print_agent_job.bin

log() { logger -t print-agent "$1"; }

if [ -z "$TOKEN" ]; then
  log "ERROR: PRINT_AGENT_TOKEN is not set"
  exit 1
fi
if [ -z "$SERVER" ]; then
  log "ERROR: PRINT_AGENT_SERVER is not set"
  exit 1
fi

HEARTBEAT_INTERVAL=30
last_heartbeat=0

log "Starting (server=$SERVER interval=${INTERVAL}s)"

while true; do
  # Send heartbeat every 30 s — token passed as query param (busybox wget compatible)
  now=$(date +%s)
  if [ $((now - last_heartbeat)) -ge $HEARTBEAT_INTERVAL ]; then
    wget -q -T 5 -O /dev/null --post-data '' \
      "$SERVER/api/print-agent/heartbeat?token=$TOKEN&serverUrl=$SERVER" 2>/dev/null
    last_heartbeat=$now
  fi

  # Poll for queued jobs — token in URL, no --header needed
  JOBS=$(wget -q -T 10 -O - \
    "$SERVER/api/print-agent/queued?token=$TOKEN" 2>/dev/null)

  if [ -n "$JOBS" ] && [ "$JOBS" != "[]" ]; then
    # Parse each job entry: {"id":N,...,"lanIp":"x.x.x.x"}
    echo "$JOBS" | grep -o '"id":[0-9]*[^}]*"lanIp":"[^"]*"' | while IFS= read -r entry; do
      JOB_ID=$(echo "$entry" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
      LAN_IP=$(echo "$entry" | grep -o '"lanIp":"[^"]*"' | sed 's/"lanIp":"//;s/"//')

      [ -z "$JOB_ID" ] || [ -z "$LAN_IP" ] && continue

      log "Job $JOB_ID -> $LAN_IP:9100"

      # Fetch raw ESC/POS bytes (atomically claims the job)
      wget -q -T 15 -O "$TMPFILE" \
        "$SERVER/api/print-agent/jobs/$JOB_ID/bytes?token=$TOKEN" 2>/dev/null

      if [ $? -eq 0 ] && [ -s "$TMPFILE" ]; then
        # Pipe bytes directly to the printer's TCP port 9100
        # (busybox nc has no -w flag; use timeout instead)
        timeout 10 nc "$LAN_IP" 9100 < "$TMPFILE" 2>/tmp/print_nc_err
        NC_STATUS=$?
        rm -f "$TMPFILE"

        if [ $NC_STATUS -eq 0 ]; then
          log "Job $JOB_ID printed OK"
          wget -q -T 10 -O /dev/null --post-data '' \
            "$SERVER/api/print-agent/jobs/$JOB_ID/complete?token=$TOKEN" 2>/dev/null
        else
          ERR_MSG=$(cat /tmp/print_nc_err 2>/dev/null | head -c 100)
          log "Job $JOB_ID nc failed ($NC_STATUS): $ERR_MSG"
          wget -q -T 10 -O /dev/null --post-data '' \
            "$SERVER/api/print-agent/jobs/$JOB_ID/fail?token=$TOKEN&error=nc+exit+$NC_STATUS" 2>/dev/null
        fi
      else
        rm -f "$TMPFILE"
        log "Job $JOB_ID bytes fetch failed"
        wget -q -T 10 -O /dev/null --post-data '' \
          "$SERVER/api/print-agent/jobs/$JOB_ID/fail?token=$TOKEN&error=bytes+fetch+failed" 2>/dev/null
      fi
    done
  fi

  sleep "$INTERVAL"
done
