#!/bin/bash
# 블로그라이터 발행 경로 일일 점검 (cron 용).
# 문제 있을 때만 텔레그램 알림 + 로그 기록. 정상이면 조용하다.
# 상세: health-check.mjs 헤더 주석 참고.
#
# ⚠️ node 버전 고정 — better-sqlite3 네이티브 바인딩이 v22 로 빌드돼 있어
#    /usr/bin/node (v18) 로 돌리면 ERR_DLOPEN_FAILED 로 죽는다. pm2 도 v22 를 쓴다.
cd /var/www/mangoabba/blogwrite/server || exit 1
set -a; [ -f .env ] && . ./.env; set +a

NODE=/home/mangoabba/.nvm/versions/node/v22.22.2/bin/node
[ -x "$NODE" ] || NODE=$(command -v node)

LOG=/var/log/blogwrite-health.log
OUT=$("$NODE" health-check.mjs --quiet 2>&1); RC=$?
if [ "$RC" != "0" ]; then
  { echo "───── $(date '+%F %T') 문제 감지 ─────"; echo "$OUT"; } >> "$LOG"
else
  echo "$(date '+%F %T') ✅ 정상" >> "$LOG"
fi
exit $RC
