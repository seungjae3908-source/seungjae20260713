"""결과 디렉터리들을 읽어 한국어 요약 표(Markdown)를 만든다."""
import json
import sys
from pathlib import Path


def fmt(v, kind="num"):
    if v is None:
        return "-"
    if kind == "pct":
        return f"{v * 100:.2f}%"
    if kind == "int":
        return f"{int(v):,}"
    if kind == "krw":
        return f"{v:,.0f}"
    return f"{v:,.2f}"


def suite_tables(result_dir: Path) -> str:
    rows = json.loads((result_dir / "summary.json").read_text())
    meta = json.loads((result_dir / "meta.json").read_text())
    out = [f"### 결과 묶음 `{result_dir.name}`", "",
           f"- 코드 SHA: `{meta.get('git_sha')}` / 데이터 지문: `{meta.get('data_fingerprint')}` / 실주문: {meta.get('live_orders')}건",
           f"- 품질 정책: {meta.get('quality_policy', '전체 데이터셋 단위(구버전)')}",
           f"- 전체 데이터셋 품질 참고(차단 아님): {json.dumps(meta.get('quality_blocking_global_informational', meta.get('quality_blocking')), ensure_ascii=False)}",
           f"- 가격 대용: {json.dumps(meta.get('price_proxies'), ensure_ascii=False)}", ""]
    claims = meta.get("readme_claims_unverified")
    if claims:
        out += ["- README 주장(검증 결과와 별도 보존, 검증된 값 아님): " + json.dumps(claims.get("values"), ensure_ascii=False), ""]
    out += window_quality_table(meta.get("window_quality") or {})
    groups = {}
    for r in rows:
        groups.setdefault((r["window"], r["strategy"], r["cost_profile"]), []).append(r)
    for (w, s, p), rs in groups.items():
        out += [f"#### {w} / {s} / 비용 {p}", "",
                "| 배율 | 상태 | 첫 진입증거금(USDT) | 다리당 최대 명목 | 순손익(USDT) | 순손익(원, 시작환율) | 순수익률 | MDD | 수수료 | 펀딩 | 슬리피지 | 스프레드 | 거래 | 순승률 | 순PF | Sharpe | 청산 | 평균보유(h) | 기본자금(원) | 예비금(원) |",
                "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in sorted(rs, key=lambda x: x["leverage"]):
            if r["status"] != "OK":
                reason = str(r.get("error") or "")[:160]
                out.append(f"| {r['leverage']}x | {r['status']} {reason} | " + " | ".join(["-"] * 18) + " |")
                continue
            out.append("| " + " | ".join([
                f"{r['leverage']}x", "OK", fmt(r["capital_units"]), fmt(r["max_notional_per_leg"]),
                fmt(r["net_pnl_units"]), fmt(r["net_pnl_krw_start_fx"], "krw"), fmt(r["net_return"], "pct"),
                fmt(r["mdd"], "pct"), fmt(r["fees"]), fmt(r["funding"]), fmt(r["slippage"]), fmt(r["spread"]),
                fmt(r["trades"], "int"), fmt(r["win_rate_net"], "pct"), fmt(r["pf_net"]), fmt(r["sharpe"]),
                fmt(r["liquidations"], "int"), fmt(r["avg_hold_h"]), fmt(r.get("fund_base_krw"), "krw"),
                fmt(r.get("fund_reserve_krw"), "krw")]) + " |")
        out.append("")
    return "\n".join(out)


def window_quality_table(wq: dict) -> list:
    """창별·데이터셋별 실제 보유 범위와 결측. 평가 시작·종료, 출처, 표본 수, 결측 구간을 그대로 적는다."""
    if not wq:
        return []
    out = ["#### 평가 창별 데이터 품질(창마다 독립 판정, 보간 없음)", "",
           "| 창 | 평가 시작 | 평가 끝(미포함) | 데이터셋 | 출처 | 기대 주기(h) | 표본 수 | 기대 수 | 첫 시각 | 마지막 시각 | 창 안 결측 | 앞 결측(h) | 뒤 결측(h) | 관측 주기(h) | 판정 | 사유 |",
           "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for w, info in wq.items():
        ws, we = info.get("window", ["-", "-"])
        for name, r in (info.get("datasets") or {}).items():
            out.append("| " + " | ".join([
                w, ws, we, name, str(r.get("source", "-")), f"{r.get('expected_interval_hours', '-')}",
                fmt(r.get("rows_in_window"), "int"), fmt(r.get("expected_rows"), "int"),
                str(r.get("first_in_window") or "-"), str(r.get("last_in_window") or "-"),
                fmt(r.get("missing_intervals"), "int"), fmt(r.get("lead_missing_hours")), fmt(r.get("tail_missing_hours")),
                "-" if r.get("observed_median_interval_hours") is None else fmt(r.get("observed_median_interval_hours")),
                str(r.get("status")), "; ".join(r.get("reasons") or [])]) + " |")
        out.append(f"| {w} | | | 마크가격 처리 | {info.get('mark_price_note', '-')} | | | | | | | | | | | |")
        for name, r in (info.get("datasets") or {}).items():
            for rng in (r.get("missing_ranges") or [])[:5]:
                out.append(f"| {w} | | | {name} 결측 구간 | {rng[0]} ~ {rng[1]} ({rng[2]}개) | | | | | | | | | | | |")
    out.append("")
    return out


def original_table(path: Path) -> str:
    r = json.loads(path.read_text())
    lines = [f"### 원본 코드 무수정 실행 ({r['mode']}, {r['start_date']} ~ {r['end_date']})", "",
             f"- 원본 HEAD `{r['original_head']}` (고정 SHA 일치: {r['head_matches_pin']}), 종료 코드 {r['exit_code']}, "
             f"시간초과 {r['timed_out']}, 소요 {r['elapsed_s']}초", "",
             "| 지표 | README 주장 | 원본 코드 공개데이터 실행 |", "|---|---|---|"]
    for k, v in r["readme_claims"].items():
        lines.append(f"| {k} | {v} | {r['produced'].get(k)} |")
    return "\n".join(lines) + "\n"


def main():
    parts = ["# Crypto-Statistical-Arbitrage 재현·검증 결과", ""]
    for arg in sys.argv[1:]:
        p = Path(arg)
        if (p / "summary.json").exists():
            parts.append(suite_tables(p))
        elif p.name == "original_run_report.json" or (p / "original_run_report.json").exists():
            parts.append(original_table(p if p.is_file() else p / "original_run_report.json"))
        elif p.suffix == ".json":
            parts.append(f"### {p.name}\n\n```json\n{p.read_text()[:6000]}\n```\n")
    print("\n".join(parts))


if __name__ == "__main__":
    main()
