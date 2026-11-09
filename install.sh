#!/usr/bin/env bash
# Cài VPS Health Monitor. Chạy với quyền root:  sudo bash install.sh
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"

if [ "$(id -u)" -ne 0 ]; then echo "Hãy chạy bằng root: sudo bash install.sh"; exit 1; fi

ask() { # ask BIEN "Câu hỏi" [mặc định]
  local var="$1" q="$2" def="${3:-}" ans
  read -r -p "$q${def:+ [$def]}: " ans < /dev/tty || true
  printf -v "$var" '%s' "${ans:-$def}"
}

# ---------- tạo .env ----------
if [ ! -f .env ]; then
  echo "== Cấu hình lần đầu =="
  ask TG_TOKEN "Telegram bot token (lấy từ @BotFather)"
  ask TG_CHAT "Telegram chat ID"
  GEN_PASS="$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16 || true)"
  ask DASH_PASS "Mật khẩu dashboard" "$GEN_PASS"
  ask SRV_NAME "Tên hiển thị của VPS" "$(hostname)"

  # Ai được xem dashboard?
  TS_IP="$(command -v tailscale >/dev/null && tailscale ip -4 2>/dev/null | head -n1 || true)"
  echo
  echo "Ai được truy cập dashboard?"
  if [ -n "$TS_IP" ]; then echo "  1) Chỉ thiết bị trong mạng Tailscale ($TS_IP) — khuyên dùng"; else echo "  1) Tailscale (chưa thấy Tailscale đang chạy trên máy này)"; fi
  echo "  2) Chỉ trên VPS (127.0.0.1) — xem qua SSH tunnel"
  echo "  3) Mở ra Internet (0.0.0.0) — KHÔNG khuyên dùng, dashboard chạy HTTP không mã hóa"
  ask ACCESS "Chọn" "$([ -n "$TS_IP" ] && echo 1 || echo 2)"
  case "$ACCESS" in
    1) if [ -z "$TS_IP" ]; then echo "Không lấy được IP Tailscale. Chạy 'tailscale up' rồi cài lại."; exit 1; fi; BIND="$TS_IP" ;;
    3) BIND="0.0.0.0" ;;
    *) BIND="127.0.0.1" ;;
  esac

  cp .env.example .env
  sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$TG_TOKEN|; s|^TELEGRAM_CHAT_ID=.*|TELEGRAM_CHAT_ID=$TG_CHAT|; s|^DASHBOARD_PASSWORD=.*|DASHBOARD_PASSWORD=$DASH_PASS|; s|^SERVER_NAME=.*|SERVER_NAME=$SRV_NAME|; s|^BIND_HOST=.*|BIND_HOST=$BIND|" .env
  chmod 600 .env
  echo "Đã lưu cấu hình vào $DIR/.env"
fi
mkdir -p data

# ---------- log SSH: Debian 12+/một số distro chỉ dùng journald ----------
if [ ! -f /var/log/auth.log ] && [ ! -f /var/log/secure ]; then
  if command -v apt-get >/dev/null; then
    echo "== Cài rsyslog để có /var/log/auth.log (phát hiện brute-force SSH) =="
    apt-get install -y rsyslog >/dev/null && systemctl enable --now rsyslog || echo "Không cài được rsyslog — bỏ qua"
  fi
fi

PORT="$(grep -E '^PORT=' .env | cut -d= -f2)"; PORT="${PORT:-3100}"
BIND="$(grep -E '^BIND_HOST=' .env | cut -d= -f2)"; BIND="${BIND:-127.0.0.1}"

# ---------- chạy bằng Docker (ưu tiên) hoặc systemd ----------
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  echo "== Chạy bằng Docker Compose =="
  docker compose up -d --build
  MODE="docker"
else
  NODE_OK=0
  if command -v node >/dev/null; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$NODE_MAJOR" -ge 18 ] && NODE_OK=1
  fi
  if [ "$NODE_OK" -ne 1 ]; then
    echo "Cần Node.js >= 18 (hoặc Docker). Cài Node 22:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
    exit 1
  fi
  echo "== Cài dịch vụ systemd =="
  cat > /etc/systemd/system/vps-health.service <<EOF
[Unit]
Description=VPS Health Monitor
After=network-online.target docker.service tailscaled.service
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/server.js
Restart=always
RestartSec=5
Environment=DATA_DIR=$DIR/data

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now vps-health
  MODE="systemd"
fi

# ---------- firewall (ufw) ----------
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  case "$BIND" in
    0.0.0.0) ufw allow "$PORT"/tcp >/dev/null && echo "Đã mở cổng $PORT ra Internet trên ufw" ;;
    100.*)   ufw allow in on tailscale0 to any port "$PORT" proto tcp >/dev/null && echo "Đã cho phép cổng $PORT chỉ qua Tailscale (tailscale0)" ;;
  esac
fi

case "$BIND" in
  0.0.0.0) URL="http://$(curl -s -4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}'):$PORT" ;;
  127.0.0.1) URL="http://127.0.0.1:$PORT  (từ máy bạn: ssh -L $PORT:127.0.0.1:$PORT user@VPS rồi mở http://localhost:$PORT)" ;;
  *) URL="http://$BIND:$PORT  (bật Tailscale trên điện thoại/máy tính rồi mở link này)" ;;
esac
echo
echo "✅ Đã cài xong ($MODE)."
echo "   Dashboard: $URL"
echo "   Đăng nhập: $(grep -E '^DASHBOARD_USER=' .env | cut -d= -f2) / (mật khẩu trong $DIR/.env)"
echo "   Telegram sẽ nhận tin 'đã khởi động' trong ~15 giây. Gõ /status cho bot để kiểm tra."
if [ "$MODE" = docker ]; then echo "   Xem log: docker logs -f vps-health"; else echo "   Xem log: journalctl -u vps-health -f"; fi
