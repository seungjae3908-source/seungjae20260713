# Paper Forward 30-Day Runbook

## 실행 (승인 후에만)
nohup node run-paper-forward-abc.mjs > paper-abc/run.log 2>&1 &
echo $! > paper-abc/orchestrator.pid

## 모니터링
tail -50 paper-abc/run.log
cat paper-abc/A-baseline/state.json | jq .totalFunding
cat paper-abc/B-trailing/state.json | jq .totalFunding
ps -p $(cat paper-abc/orchestrator.pid) -o pid,etime,cmd

## 안전 종료 (SIGTERM)
kill -TERM $(cat paper-abc/orchestrator.pid)
sleep 3
ls paper-abc/A-baseline/lock paper-abc/B-trailing/lock 2>/dev/null || echo "clean"

## 복구 (fail-closed 발동 시)
# 1. 에러 로그 확인
grep FAIL_CLOSED paper-abc/run.log
# 2. 수동 복구: backup 파일이 있으면 복원
cp paper-abc/A-baseline/state.json.backup paper-abc/A-baseline/state.json
# 3. 또는 수동 초기화 결정 (데이터 유실 감수)
rm paper-abc/A-baseline/state.json
# 4. 재실행
nohup node run-paper-forward-abc.mjs > paper-abc/run.log 2>&1 &

## 로그 로테이션 (매주)
mv paper-abc/run.log paper-abc/run.log.$(date +%Y%m%d)
