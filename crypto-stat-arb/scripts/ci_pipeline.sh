#!/usr/bin/env bash
# 공개 데이터 수집 → 원본 무수정 실행 → 레버리지 1~10배 백테스트 → 재현성 → 장애 주입 → 보고서.
# 실주문·계정 API 없음. 모든 단계의 시작/끝 시각과 코드 SHA 를 로그에 남긴다.
set -uo pipefail
cd "$(dirname "$0")/.."
W="${CSA_WORK:-$RUNNER_TEMP/csa}"
mkdir -p "$W"
LOG="$W/stages.log"
SHA="$(git rev-parse HEAD)"
END_MONTH="$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)"
RECENT_END="$(date -u +%Y-%m-01)"
STATUS=0
stage() { echo "=== [$(date -u +%FT%TZ)] STAGE $1 (sha $SHA) ===" | tee -a "$LOG"; }
done_() { echo "=== [$(date -u +%FT%TZ)] END $1 rc=$2 ===" | tee -a "$LOG"; [ "$2" = 0 ] || STATUS=1; }

stage "E_collect_public_readonly 2020-01..$END_MONTH"
python -m csa_lab collect --data-dir "$W/data" --start 2020-01 --end "$END_MONTH"
done_ E_collect $?
mkdir -p "$W/results"; cp "$W/data/collect_report.json" "$W/results/collect_report_main.json" 2>/dev/null || true  # 고장 주입 단계가 같은 경로를 덮어쓰므로 본 수집 보고를 따로 보존

stage "BITGET_leverage_evidence_readonly"
python scripts/bitget_leverage_evidence.py "$W/bitget_leverage_evidence.json"
done_ BITGET_evidence $?

stage "B_original_clone_pinned"
git clone --quiet https://github.com/abailey81/Crypto-Statistical-Arbitrage "$W/original" \
  && git -C "$W/original" checkout --quiet 44b718e4a4ef875ea12dfda30370ab1cc8b54a26 \
  && git -C "$W/original" rev-parse HEAD
done_ B_clone $?

stage "B_original_unmodified_readme_test_window"
python -m csa_lab original --original-repo "$W/original" --data-dir "$W/data" --out "$W/original-readme-test" \
  --mode full_backtest --start-date 2023-07-01 --end-date 2024-12-31 --timeout 2400 | tail -40
done_ B_original_test $?

stage "B_original_unmodified_default_range_2020_2026"
python -m csa_lab original --original-repo "$W/original" --data-dir "$W/data" --out "$W/original-default" \
  --mode full_backtest --start-date 2020-01-01 --end-date 2026-01-31 --timeout 3000 | tail -40
done_ B_original_default $?

stage "B_original_accounting_demo_synthetic"
python scripts/original_accounting_demo.py "$W/original" "$W/original-demo"
done_ B_demo $?

stage "H_I_leverage_1_7_backtest"
OUT1=$(python -m csa_lab backtest --data-dir "$W/data" --results-dir "$W/results" --leverage all --label suite \
  --window "readme_train=2022-01-01:2023-07-01" --window "readme_test=2023-07-01:2025-01-01" \
  --window "recent=2025-01-01:$RECENT_END" | tail -1)
rc=$?; echo "$OUT1"; done_ H_backtest $rc

stage "F_reproducibility_rerun"
OUT2=$(python -m csa_lab backtest --data-dir "$W/data" --results-dir "$W/results" --leverage all --label rerun \
  --window "readme_train=2022-01-01:2023-07-01" --window "readme_test=2023-07-01:2025-01-01" \
  --window "recent=2025-01-01:$RECENT_END" | tail -1)
python - "$OUT1" "$OUT2" <<'PY'
import json, sys
a = json.load(open(sys.argv[1] + "/summary.json")); b = json.load(open(sys.argv[2] + "/summary.json"))
print("REPRODUCIBLE" if a == b else "NOT_REPRODUCIBLE", len(a), "rows")
sys.exit(0 if a == b else 1)
PY
done_ F_repro $?

stage "13_integrity_verify"
python -m csa_lab verify "$OUT1" && python -m csa_lab verify "$OUT2" \
  && python -m csa_lab verify "$W/original-readme-test" && python -m csa_lab verify "$W/original-default"
done_ integrity $?

stage "G_fault_injection_real_network"
python scripts/fault_injection.py "$W/data" "$W/faults"
done_ G_faults $?

stage "REPORT"
python scripts/make_report.py "$OUT1" "$W/original-readme-test" "$W/original-default" "$W/original-demo" \
  "$W/data/collect_report.json" "$W/bitget_leverage_evidence.json" | tee "$W/REPORT.md"
echo "--- data quality (whole collection, informational) ---"; python -c "import json;m=json.load(open('$OUT1/meta.json'));print(json.dumps(m['data_quality'],ensure_ascii=False,indent=1))"
echo "--- window quality (per evaluation window, decides BLOCKED/INCOMPLETE) ---"; python -c "import json;m=json.load(open('$OUT1/meta.json'));print(json.dumps(m['window_quality'],ensure_ascii=False,indent=1))"
echo "--- complete sub-windows of INCOMPLETE windows (evaluated / excluded intervals) ---"; python -c "import json;m=json.load(open('$OUT1/meta.json'));print(json.dumps({w:i.get('complete_subwindows') for w,i in m['window_quality'].items() if i.get('complete_subwindows')},ensure_ascii=False,indent=1))"
echo "--- bars dropped for missing leg prices (per run) ---"; python - <<PY
import json,glob
for f in sorted(glob.glob('$OUT1/runs/*/*/*/lev*.json')):
    if f.endswith('.fund.json'): continue  # 자금 원장 파일에는 metrics 가 없음
    m=json.load(open(f)).get('metrics') or {}
    print(f, m.get('bars_dropped_missing_leg', 0), (m.get('bars_dropped_missing_leg_ts') or [])[:5])
PY
echo "--- upbit/bitget collection (executable venue pair) ---"; python -c "import json;r=json.load(open('$W/results/collect_report_main.json'));print(json.dumps(r.get('upbit_bitget'),ensure_ascii=False,indent=1))"
echo "--- carry_upbit_bitget rows ---"; python -c "import json;r=json.load(open('$OUT1/summary.json'));[print(x['window'],x['cost_profile'],x['leverage'],x['status'],x.get('net_return'),x.get('trades'),x.get('pf_net'),x.get('liquidations'),x.get('mdd'),(x.get('error') or '')[:160]) for x in r if x['strategy']=='carry_upbit_bitget']"
echo "--- hedge adapter gate evidence (PerformanceEvidence) ---"; python scripts/export_gate_evidence.py "$OUT1" "$W/results/gate_evidence_carry_upbit_bitget.json"
echo "--- summary status counts ---"; python -c "import json,collections;r=json.load(open('$OUT1/summary.json'));print(collections.Counter((x['window'],x['strategy'],x['status']) for x in r))"
cat "$LOG"
exit $STATUS
