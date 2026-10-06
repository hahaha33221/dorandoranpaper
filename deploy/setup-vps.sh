#!/usr/bin/env bash
# Hostinger VPS (Ubuntu) 최초 1회 설정
#   ssh root@<VPS> 'bash -s' < deploy/setup-vps.sh <API_DOMAIN>
set -euo pipefail

API_DOMAIN="${1:?사용법: setup-vps.sh <API_DOMAIN 예: srv123456.hstgr.cloud>}"
APP_DIR=/opt/dorandoran
REPO=https://github.com/hahaha33221/dorandoranpaper.git

if ! command -v docker >/dev/null 2>&1; then
  echo "▶ Docker 설치"
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git; }

if [ ! -d "$APP_DIR/.git" ]; then
  echo "▶ 저장소 복제 → $APP_DIR"
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
git pull --ff-only

echo "API_DOMAIN=$API_DOMAIN" > .env
mkdir -p data
chown -R 1000:1000 data   # 컨테이너의 node 사용자(uid 1000)가 DB를 쓸 수 있게

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then
  ufw allow 80/tcp && ufw allow 443/tcp
fi

docker compose up -d --build
echo "✔ 완료: https://$API_DOMAIN/api/health"
