#!/usr/bin/env bash
# يشغّل Zone-BarMi على سيرفر ثابت (بدل GitHub Actions): السيرفر + نفق cloudflared + نشر رابط النفق للوحة.
# نفس اللي كان يسويه الأكشن بالضبط، بس بدون حد زمني ولا تجديد. تشغّله خدمة systemd (شوف vps/setup.sh).
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
mkdir -p logs temp

log() { echo "[$(date '+%F %T')] $*"; }
envval() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }

PORT="$(envval PORT)"; PORT="${PORT:-3000}"
TOKEN="$(envval GH_PUSH_TOKEN)"; [ -z "$TOKEN" ] && TOKEN="$(envval GH_PAT)"
REPO="$(envval GH_REPO)"
BRANCH="$(envval GH_BRANCH)"; BRANCH="${BRANCH:-main}"
PAGE="$(envval PANEL_PAGE_URL)"
TG_API_ID="$(envval TG_API_ID)"; TG_API_HASH="$(envval TG_API_HASH)"
TBOT="$(envval TELEGRAM_BOT_TOKEN)"; TCHAT="$(envval TELEGRAM_CHAT_ID)"

if [ ! -f .env ]; then log "❌ ما فيه ملف .env — انسخ vps/env.example إلى .env وعبّيه"; exit 1; fi

notify() {
  [ -z "$TBOT" ] || [ -z "$TCHAT" ] && return 0
  curl -s -m 15 -X POST "https://api.telegram.org/bot${TBOT}/sendMessage" -d chat_id="$TCHAT" --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

SERVER_PID=""; CF_PID=""
cleanup() { log "إيقاف..."; [ -n "$CF_PID" ] && kill "$CF_PID" 2>/dev/null; [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; exit 0; }
trap cleanup TERM INT

# ---- تيليجرام المحلي (أجزاء حتى 2GB) — اختياري ----
EXTRA_ENV=()
if [ -n "$TG_API_ID" ] && [ -n "$TG_API_HASH" ] && command -v docker >/dev/null 2>&1; then
  mkdir -p temp/tgapi
  docker rm -f tgapi >/dev/null 2>&1
  if docker run -d --name tgapi --restart unless-stopped -p 127.0.0.1:8081:8081 \
      -v "$ROOT/temp/tgapi:/var/lib/telegram-bot-api" \
      -e TELEGRAM_API_ID="$TG_API_ID" -e TELEGRAM_API_HASH="$TG_API_HASH" -e TELEGRAM_LOCAL=1 \
      aiogram/telegram-bot-api:latest >/dev/null 2>&1; then
    for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:8081/ && break; sleep 1; done
    EXTRA_ENV=(TG_UPLOAD_API=http://127.0.0.1:8081 TG_UPLOAD_LOCAL=1)
    log "✅ telegram-bot-api المحلي شغال"
  else
    log "⚠️ ما قدرت أشغّل telegram-bot-api (تأكد من docker) — الرفع بالحد الرسمي 50MB"
  fi
fi

start_server() {
  [ -f logs/server.log ] && [ "$(stat -c %s logs/server.log)" -gt 52428800 ] && mv -f logs/server.log logs/server.log.1
  env "${EXTRA_ENV[@]}" node server.js >> logs/server.log 2>&1 &
  SERVER_PID=$!
  log "السيرفر شغّال (pid $SERVER_PID)"
}

URL=""
start_tunnel() {
  [ -n "$CF_PID" ] && kill "$CF_PID" 2>/dev/null
  : > logs/cf.log
  cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >> logs/cf.log 2>&1 &
  CF_PID=$!
  URL=""
  for i in $(seq 1 45); do
    URL="$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' logs/cf.log | head -n1)"
    [ -n "$URL" ] && break
    sleep 2
  done
  [ -n "$URL" ] && log "رابط النفق: $URL" || log "⚠️ ما انطلع رابط نفق"
}

publish() {
  local url="$1"
  mkdir -p docs
  printf '{\n  "panelUrl": "%s",\n  "startedAt": "%s",\n  "permanent": true,\n  "host": "vps"\n}\n' "$url" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > docs/current-stream.json
  if [ -z "$TOKEN" ] || [ -z "$REPO" ] || [ ! -d .git ]; then
    log "⚠️ تخطي رفع الرابط لـ GitHub (ناقص GH_REPO أو GH_PUSH_TOKEN، أو المجلد مو git)"; return 1
  fi
  git config user.name "zone-barmi-vps"; git config user.email "vps@users.noreply.github.com"
  git remote set-url origin "https://x-access-token:${TOKEN}@github.com/${REPO}.git"
  git add docs/current-stream.json
  git commit -q -m "تحديث رابط السيرفر [skip ci]" 2>/dev/null || true
  for i in 1 2 3 4 5; do
    if git pull --rebase --autostash -q origin "$BRANCH" 2>/dev/null && git push -q origin "HEAD:$BRANCH" 2>/dev/null; then log "✅ نُشر رابط اللوحة"; return 0; fi
    sleep 4
  done
  log "❌ فشل رفع الرابط لـ GitHub"; return 1
}

announce() {
  local msg="✅ سيرفر Zone-BarMi شغّال."
  [ -n "$PAGE" ] && msg="$msg"$'\n\n'"🌐 اللوحة: $PAGE"
  msg="$msg"$'\n\n'"رابط النفق الحالي (للمرجع): $URL"
  notify "$msg"
}

start_server
sleep 5
start_tunnel
if [ -n "$URL" ]; then publish "$URL" || notify "⚠️ السيرفر شغّال لكن ما قدرت أحدّث رابط اللوحة على GitHub. شوف logs/run.log"; announce; fi

BAD=0; TICK=0
while true; do
  sleep 20
  TICK=$((TICK + 1))
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then log "السيرفر وقف — خروج (systemd يعيد التشغيل)"; notify "⚠️ سيرفر Zone-BarMi وقف وأعيد تشغيله."; kill "$CF_PID" 2>/dev/null; exit 1; fi
  RESTART_TUNNEL=0
  if ! kill -0 "$CF_PID" 2>/dev/null; then log "النفق وقف"; RESTART_TUNNEL=1; fi
  if [ $((TICK % 3)) -eq 0 ] && [ -n "$URL" ] && [ "$RESTART_TUNNEL" -eq 0 ]; then
    CODE="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$URL/" || true)"
    case "$CODE" in 000|502|503|504|530|1033) BAD=$((BAD + 1));; *) BAD=0;; esac
    [ "$BAD" -ge 3 ] && { log "النفق ما يرد (code $CODE) — أعيد تشغيله"; RESTART_TUNNEL=1; BAD=0; }
  fi
  if [ "$RESTART_TUNNEL" -eq 1 ]; then
    start_tunnel
    if [ -n "$URL" ]; then publish "$URL"; notify "🔁 تغيّر رابط النفق وتم تحديث اللوحة تلقائيًا."; fi
  fi
  # تنظيف دوري: ملفات مؤقتة قديمة (أكثر من يومين) عشان القرص ما يمتلي
  if [ $((TICK % 180)) -eq 0 ]; then
    find temp -mindepth 1 -maxdepth 1 -mtime +2 ! -name tgapi -exec rm -rf {} + 2>/dev/null
    find temp/tgapi -type f -mtime +1 -delete 2>/dev/null
  fi
done
