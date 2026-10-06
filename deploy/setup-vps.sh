#!/usr/bin/env bash
# 도란도란 API — VPS 최초 설정 (다른 서비스와 같은 서버에서 겹치지 않게)
#
#   점검만:  ssh root@<VPS> 'bash -s' < deploy/setup-vps.sh <호스트명> --check
#   설치:    ssh root@<VPS> 'bash -s' < deploy/setup-vps.sh <호스트명> [옵션]
#
#   옵션
#     --mode auto|proxy|standalone   기본 auto (80/443을 누가 쓰고 있으면 proxy, 비어 있으면 standalone)
#     --port N                        API 포트 (127.0.0.1 전용, 기본 18787)
#     --nginx                         proxy 모드에서 기존 nginx 설정에 /dorandoran-api/ 경로를 자동 추가
#     --check                         아무것도 바꾸지 않고 서버 상태만 점검
#
#   이 스크립트가 만드는/쓰는 것 (다른 서비스와 분리)
#     폴더 /opt/dorandoran, 컨테이너 dorandoran-*, 네트워크 dorandoran, 포트 127.0.0.1:<API_PORT>
set -euo pipefail

HOST="${1:-}"
[ -n "$HOST" ] && [ "${HOST#--}" = "$HOST" ] || { echo "사용법: setup-vps.sh <호스트명> [--mode auto|proxy|standalone] [--port N] [--nginx] [--check]"; exit 1; }
shift
MODE=auto; API_PORT=18787; DO_NGINX=0; CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --port) API_PORT="$2"; shift 2 ;;
    --nginx) DO_NGINX=1; shift ;;
    --check) CHECK=1; shift ;;
    *) echo "알 수 없는 옵션: $1"; exit 1 ;;
  esac
done

APP_DIR=/opt/dorandoran
REPO=https://github.com/hahaha33221/dorandoranpaper.git

listening() { ss -ltnpH "( sport = :$1 )" 2>/dev/null || true; }
port_owner() { listening "$1" | sed -E 's/.*users:\(\("([^"]+)".*/\1/' | sort -u | paste -sd, -; }

echo "━━━ 서버 점검 ━━━"
for p in 80 443; do
  owner=$(port_owner $p)
  echo "· 포트 $p: ${owner:-비어 있음}"
done
own_port=$(port_owner "$API_PORT")
if [ -n "$own_port" ] && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dorandoran-api; then
  echo "· 포트 $API_PORT: $own_port 가 사용 중 → --port 로 다른 포트를 지정하세요"
  PORT_TAKEN=1
else
  echo "· 포트 $API_PORT (도란도란 API용): 사용 가능"
  PORT_TAKEN=0
fi
command -v nginx >/dev/null 2>&1 && echo "· nginx 설치됨: $(nginx -v 2>&1)"
command -v caddy >/dev/null 2>&1 && echo "· caddy 설치됨 (호스트)"
command -v docker >/dev/null 2>&1 && echo "· docker: $(docker --version)" || echo "· docker: 없음 (설치 예정)"
if command -v docker >/dev/null 2>&1; then
  pubs=$(docker ps --format '{{.Names}} {{.Ports}}' | grep -E ':(80|443)->' || true)
  [ -n "$pubs" ] && echo "· 80/443을 쓰는 컨테이너:" && echo "$pubs" | sed 's/^/    /'
fi
free -h 2>/dev/null | awk 'NR==2{print "· 메모리: 전체 "$2", 사용 가능 "$7}'

if [ "$MODE" = auto ]; then
  if [ -z "$(listening 80)$(listening 443)" ]; then MODE=standalone; else MODE=proxy; fi
fi
echo "· 선택된 모드: $MODE"
[ "$PORT_TAKEN" = 1 ] && exit 1
if [ "$MODE" = standalone ] && [ -n "$(listening 80)$(listening 443)" ]; then
  echo "✖ 80/443을 이미 다른 서비스가 쓰고 있어 standalone 모드를 쓸 수 없어요. --mode proxy 를 쓰세요."
  exit 1
fi
[ "$CHECK" = 1 ] && { echo "(점검만 했어요. 바뀐 것은 없어요)"; exit 0; }

echo "━━━ 설치 ━━━"
if ! command -v docker >/dev/null 2>&1; then
  echo "▶ Docker 설치"
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git; }

if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
git pull --ff-only

{
  echo "API_DOMAIN=$HOST"
  echo "API_PORT=$API_PORT"
  [ "$MODE" = standalone ] && echo "COMPOSE_PROFILES=standalone"
} > .env
mkdir -p data
chown -R 1000:1000 data # 컨테이너의 node 사용자(uid 1000)

# nginx 연결용 설정 (포트 반영본)
sed "s/127.0.0.1:18787/127.0.0.1:$API_PORT/" deploy/nginx-dorandoran.conf > deploy/nginx-dorandoran.local.conf

if [ "$MODE" = standalone ] && command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then
  ufw allow 80/tcp && ufw allow 443/tcp
fi

docker compose up -d --build
sleep 3
curl -fs "http://127.0.0.1:$API_PORT/api/health" >/dev/null && echo "✔ API 실행 중 (127.0.0.1:$API_PORT)"

INCLUDE_LINE="include $APP_DIR/deploy/nginx-dorandoran.local.conf;"
if [ "$MODE" = proxy ]; then
  if [ "$DO_NGINX" = 1 ] && command -v nginx >/dev/null 2>&1; then
    if grep -Rqs "nginx-dorandoran" /etc/nginx/; then
      echo "· nginx: 이미 연결돼 있어요"
    else
      conf=$(grep -RlsE "server_name[^;]*\b${HOST//./\\.}\b" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | xargs -r grep -l "listen.*443" | head -1 || true)
      if [ -z "$conf" ]; then
        echo "✖ '$HOST' 의 HTTPS server 블록을 찾지 못했어요. 아래 줄을 직접 넣어 주세요."
      else
        cp "$conf" "$conf.bak-dorandoran"
        # server_name 줄 다음에 include 추가 (해당 호스트 블록 첫 번째)
        awk -v host="$HOST" -v line="    $INCLUDE_LINE" '
          !done && $0 ~ "server_name" && index($0, host) { print; print line; done=1; next } { print }
        ' "$conf.bak-dorandoran" > "$conf"
        if nginx -t 2>/dev/null; then
          systemctl reload nginx && echo "✔ nginx 에 /dorandoran-api/ 연결: $conf (백업 $conf.bak-dorandoran)"
        else
          mv "$conf.bak-dorandoran" "$conf"
          echo "✖ nginx 설정 검사 실패 → 원래대로 되돌렸어요. 아래 줄을 직접 넣어 주세요."
        fi
      fi
    fi
  fi
  if ! grep -Rqs "nginx-dorandoran" /etc/nginx/ 2>/dev/null; then
    cat <<EOF

━━━ 남은 일: 기존 웹서버에 경로 하나만 추가 ━━━
 [nginx]  '$HOST' 의 HTTPS server { } 블록 안에:
     $INCLUDE_LINE
   → nginx -t && systemctl reload nginx

 [Caddy]  '$HOST' 사이트 블록 안에:
     handle_path /dorandoran-api/* {
         rewrite * /api{uri}
         reverse_proxy 127.0.0.1:$API_PORT
     }
   (Caddy가 Docker 컨테이너라면 127.0.0.1 대신 host.docker.internal:$API_PORT
    또는 'docker network connect dorandoran <caddy컨테이너>' 후 dorandoran-api:8787)

 [Traefik/기타]  https://$HOST/dorandoran-api/*  →  http://127.0.0.1:$API_PORT/api/*
EOF
  fi
fi

echo
echo "확인: curl https://$HOST/dorandoran-api/health  →  {\"ok\":true}"
