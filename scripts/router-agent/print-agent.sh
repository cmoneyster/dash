#!/bin/sh
#
# dash Catering — GL.iNet router print agent
#
# Polls the server for pending print jobs and sends raw ESC/POS bytes
# directly to the Star TSP143IV on TCP port 9100.
#
# Confirmed working on GL-SFT1200 running OpenWrt (BusyBox v1.29.3).
# Requires: curl, jq, openssl (all present on stock GL.iNet firmware).
#
# SETUP (run once on the router as root):
#   ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.22.1
#
#   # Download pre-filled script from the server:
#   wget -O /root/print-agent.sh \
#     'https://YOUR_SERVER/api/print-agent/install.sh?token=TOKEN&printer=PRINTER_IP'
#
#   # Launch (survives SSH disconnect via trap '' HUP):
#   sh /root/print-agent.sh </dev/null >> /var/log/print-agent.log 2>&1 &
#
#   # Auto-start on boot — add to /etc/rc.local before "exit 0":
#   sh /root/print-agent.sh </dev/null >> /var/log/print-agent.log 2>&1 &
#
#   # Watchdog cron (restarts if crashed) — write to /etc/crontabs/root:
#   * * * * * pgrep -f print-agent.sh > /dev/null || sh /root/print-agent.sh </dev/null >> /var/log/print-agent.log 2>&1 &
#
# CONFIGURATION — edit these three lines:
SERVER="https://YOUR_SERVER"
ADMIN_TOKEN="PASTE_YOUR_ADMIN_BEARER_TOKEN_HERE"
PRINTER_IP="192.168.22.208"

PRINTER_PORT=9100
POLL_INTERVAL=2
LOG_TAG="print-agent"

# Ignore SIGHUP so the agent survives SSH disconnects (nohup unavailable on BusyBox).
trap '' HUP

log() { logger -t "$LOG_TAG" "$1"; }

log "starting — server=$SERVER printer=$PRINTER_IP:$PRINTER_PORT"

while true; do
  JOBS=$(curl -sf \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$SERVER/api/print-agent/queued" 2>/dev/null)

  if [ -z "$JOBS" ] || [ "$JOBS" = "[]" ]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  COUNT=$(printf '%s' "$JOBS" | jq 'length' 2>/dev/null)
  if [ -z "$COUNT" ] || [ "$COUNT" -eq 0 ]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  i=0
  while [ "$i" -lt "$COUNT" ]; do
    JOB_ID=$(printf '%s' "$JOBS"   | jq -r ".[$i].id")
    JOB_TYPE=$(printf '%s' "$JOBS" | jq -r ".[$i].jobType")
    RAW_B64=$(printf '%s' "$JOBS"  | jq -r ".[$i].rawBytesBase64")

    if [ -z "$JOB_ID" ] || [ "$JOB_ID" = "null" ]; then
      i=$((i + 1))
      continue
    fi

    log "claiming job $JOB_ID ($JOB_TYPE)"
    curl -sf -X POST \
      -H "Authorization: Bearer $ADMIN_TOKEN" \
      "$SERVER/api/print-agent/jobs/$JOB_ID/claim" \
      -o /dev/null || { log "job $JOB_ID already claimed — skipping"; i=$((i+1)); continue; }

    log "sending job $JOB_ID to $PRINTER_IP:$PRINTER_PORT"
    # openssl enc -base64 -d -A handles single-line base64 (no line-wrap requirement).
    # Plain nc (no flags) closes after stdin EOF — BusyBox nc doesn't support -w.
    printf '%s' "$RAW_B64" | openssl enc -base64 -d -A | nc "$PRINTER_IP" "$PRINTER_PORT"
    STATUS=$?

    if [ "$STATUS" -eq 0 ]; then
      log "job $JOB_ID delivered OK"
      curl -sf -X POST \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"printerResponse":"tcp_9100_ok"}' \
        "$SERVER/api/print-agent/jobs/$JOB_ID/complete" \
        -o /dev/null
    else
      log "job $JOB_ID FAILED (nc exit $STATUS)"
      curl -sf -X POST \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"error\":\"tcp_connect_failed\"}" \
        "$SERVER/api/print-agent/jobs/$JOB_ID/fail" \
        -o /dev/null
    fi

    i=$((i + 1))
  done

  sleep "$POLL_INTERVAL"
done
