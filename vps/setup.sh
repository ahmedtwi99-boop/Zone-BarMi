#!/usr/bin/env bash
# تجهيز سيرفر Ubuntu/Debian لتشغيل Zone-BarMi دائمًا: ./vps/setup.sh  (بصلاحية root)
set -e
[ "$(id -u)" -eq 0 ] || { echo "شغّله كـ root: sudo ./vps/setup.sh"; exit 1; }
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "== تثبيت الأدوات =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ffmpeg git curl ca-certificates docker.io
systemctl enable --now docker || true
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  case "$(uname -m)" in aarch64|arm64) A=arm64;; *) A=amd64;; esac
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$A" -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
fi

echo "== تثبيت مكتبات المشروع =="
npm install --omit=dev

if [ ! -f .env ]; then
  cp vps/env.example .env
  echo
  echo "⚠️ أنشأت ملف .env من النموذج. عبّيه (nano .env) ثم شغّل هذا الأمر مرة ثانية."
  exit 0
fi

echo "== إنشاء خدمة التشغيل الدائم =="
chmod +x vps/run.sh
cat > /etc/systemd/system/zone-barmi.service <<UNIT
[Unit]
Description=Zone-BarMi server + tunnel
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=/bin/bash $ROOT/vps/run.sh
Restart=always
RestartSec=5
KillMode=control-group
StandardOutput=append:$ROOT/logs/run.log
StandardError=append:$ROOT/logs/run.log

[Install]
WantedBy=multi-user.target
UNIT
mkdir -p logs
systemctl daemon-reload
systemctl enable zone-barmi
systemctl restart zone-barmi
echo
echo "✅ تم. الحالة:  systemctl status zone-barmi"
echo "   السجل:       tail -f $ROOT/logs/run.log"
