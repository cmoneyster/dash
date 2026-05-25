#!/bin/sh
#
# dash Catering — GL.iNet router print agent
#
# Polls the server for pending print jobs and sends raw ESC/POS bytes
# directly to the Star TSP143IV on TCP port 9100 — the same method
# Square uses, confirmed working on this printer.
#
# SETUP (run once on the router as root):
#   ssh root@192.168.22.1
#   opkg update && opkg install jq curl
#   cp print-agent.sh /usr/bin/print-agent.sh
#   chmod +x /usr/bin/print-agent.sh
#   cp print-agent.init /etc/init.d/print-agent
#   chmod +x /etc/init.d/print-agent
#   /etc/init.d/print-agent enable
#   /etc/init.d/print-agent start
#
# CONFIGURATION — edit these three lines:
SERVER="https://4dbb42c8-7232-4c1b-9ec9-bd7769d819bd-00-370kak3ug5c9z.kirk.replit.dev"
ADMIN_TOKEN="PASTE_YOUR_ADMIN_BEARER_TOKEN_HERE"
PRINTER_IP="192.168.22.208"

PRINTER_PORT=9100
POLL_INTERVAL=2
LOG_TAG="print-agent"

log() { logger -t "$LOG_TAG" "$1"; }

claim_job() {
  curl -sf -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$SERVER/api/print-agent/jobs/$1/claim" \
    -o /dev/null
  return $?
}

complete_job() {
  curl -sf -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"printerResponse":"tcp_9100_ok"}' \
    "$SERVER/api/print-agent/jobs/$1/complete" \
    -o /dev/null
}

fail_job() {
  curl -sf -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"error\":\"$2\"}" \
    "$SERVER/api/print-agent/jobs/$1/fail" \
    -o /dev/null
}

send_to_printer() {
  # Decode base64 ESC/POS bytes and pipe to printer TCP port 9100.
  # -w 10: abort if connection not established within 10 s.
  # stdin EOF naturally closes the nc connection once all bytes are sent.
  printf '%s' "$1" | base64 -d | nc -w 10 "$PRINTER_IP" "$PRINTER_PORT"
  return $?
}

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
    claim_job "$JOB_ID"
    CLAIM_STATUS=$?

    if [ "$CLAIM_STATUS" -ne 0 ]; then
      log "job $JOB_ID already claimed — skipping"
      i=$((i + 1))
      continue
    fi

    log "sending job $JOB_ID to $PRINTER_IP:$PRINTER_PORT"
    send_to_printer "$RAW_B64"
    SEND_STATUS=$?

    if [ "$SEND_STATUS" -eq 0 ]; then
      log "job $JOB_ID delivered OK"
      complete_job "$JOB_ID"
    else
      log "job $JOB_ID FAILED (nc exit $SEND_STATUS)"
      fail_job "$JOB_ID" "tcp_connect_failed"
    fi

    i=$((i + 1))
  done

  sleep "$POLL_INTERVAL"
done
