#!/bin/sh
# 원드라이브 사진첩 폴더 → /data (= data/photos-src) 주기적 동기화 (원드라이브는 읽기만 함)
#   PHOTOS_REMOTE   예) onedrive:도란도란/사진첩
#   PHOTOS_INTERVAL 초, 기본 1800 (30분)
# /data/.sync-now 가 생기면(관리자 '지금 확인') 바로 동기화
set -u
INTERVAL="${PHOTOS_INTERVAL:-1800}"
[ -n "${PHOTOS_REMOTE:-}" ] || { echo "PHOTOS_REMOTE 가 비어 있어요"; sleep 3600; exit 1; }

sync_once() {
  echo "[$(date '+%F %T')] 동기화 시작: $PHOTOS_REMOTE"
  if rclone sync "$PHOTOS_REMOTE" /data \
      --exclude ".*" --exclude "Thumbs.db" --exclude "desktop.ini" \
      --exclude "*.{mov,MOV,mp4,MP4,m4v,M4V,avi,AVI,3gp,3GP}" \
      --transfers 2 --checkers 4 --retries 3 --low-level-retries 10 \
      --stats 0 --log-level NOTICE; then
    touch /data/.scan-request   # 사진 서버에 "새 사진 확인" 요청
    date -u '+%FT%TZ' > /data/.last-sync
    echo "[$(date '+%F %T')] 동기화 완료"
  else
    echo "[$(date '+%F %T')] 동기화 실패 (다음 주기에 다시 시도)"
    date -u '+%FT%TZ' > /data/.last-sync-error
  fi
}

while true; do
  rm -f /data/.sync-now
  sync_once
  waited=0
  while [ "$waited" -lt "$INTERVAL" ]; do
    [ -f /data/.sync-now ] && break
    sleep 30; waited=$((waited + 30))
  done
done
