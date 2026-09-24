#!/bin/sh
# ── מחליף את supervisord: מפעיל את baileys + fastapi מיד (בלי המתנת ~1s) ──
#    • כל תהליך ב-loop משלו — נופל ⇒ עולה מחדש אחרי 1s (כמו autorestart)
#    • SIGTERM (docker stop) ⇒ מועבר לשני התהליכים ⇒ כיבוי graceful
set -u
mkdir -p /var/log

run_baileys() {
  while true; do
    PORT=3001 NODE_ENV=production \
      node /app/baileys/src/index.js >>/var/log/baileys.log 2>&1
    echo "$(date -Is) [start.sh] baileys exited ($?) — restarting in 1s" >>/var/log/baileys.log
    sleep 1
  done
}

run_fastapi() {
  cd /app/fastapi
  while true; do
    BAILEYS_URL="http://localhost:3001" \
      /opt/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 >>/var/log/fastapi.log 2>&1
    echo "$(date -Is) [start.sh] fastapi exited ($?) — restarting in 1s" >>/var/log/fastapi.log
    sleep 1
  done
}

run_baileys & B_LOOP=$!
run_fastapi & F_LOOP=$!
echo "$(date -Is) [start.sh] started baileys + fastapi"

shutdown() {
  echo "$(date -Is) [start.sh] SIGTERM — stopping"
  kill -TERM "$B_LOOP" "$F_LOOP" 2>/dev/null          # עוצר את ה-loops (לא יעלו מחדש)
  pkill -TERM -f "node /app/baileys/src/index.js" 2>/dev/null
  pkill -TERM -f "uvicorn app.main:app" 2>/dev/null
  wait
  exit 0
}
trap shutdown TERM INT

wait