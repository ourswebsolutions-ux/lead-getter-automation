#!/usr/bin/env bash
# Verifies this host can open outbound SMTP connections (required for Reacher SMTP checks).
host="${1:-gmail-smtp-in.l.google.com}"
if timeout 10 bash -c "exec 3<>/dev/tcp/$host/25 && head -c 60 <&3"; then
  echo; echo "OK: outbound port 25 to $host is open."
else
  echo "BLOCKED: cannot reach $host:25. Ask your provider to unblock outbound SMTP or use another host."; exit 1
fi
