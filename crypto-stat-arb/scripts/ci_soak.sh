#!/usr/bin/env bash
# 장시간 무주문 실행: 전반부 실행 → SIGKILL(비정상 종료 주입) → 재시작 후 후반부 실행 → 요약.
set -uo pipefail
cd "$(dirname "$0")/.."
R="${CSA_SOAK_ROOT:-$RUNNER_TEMP/soak}"
H1="${SOAK_FIRST_HOURS:-2}"
H2="${SOAK_SECOND_HOURS:-3.3}"
echo "soak start $(date -u +%FT%TZ) sha $(git rev-parse HEAD) first=${H1}h second=${H2}h"
python -m csa_lab soak --root "$R" --hours "$H1" --interval-s 300 &
PID=$!
SECS=$(python -c "print(int(float('$H1')*3600) - 120)")
sleep "$SECS"
echo "inject SIGKILL $(date -u +%FT%TZ) pid $PID"; kill -9 "$PID"; wait "$PID"
echo "restart $(date -u +%FT%TZ)"
python -m csa_lab soak --root "$R" --hours "$H2" --interval-s 300
RC=$?
echo "soak end $(date -u +%FT%TZ) rc=$RC"
python -m csa_lab soak-summary --root "$R" | tee "$R/SUMMARY.json"
ls -la "$R/logs"
exit $RC
