"""원본 회계 결함 시연: 무작위 가격(랜덤워크)과 고정 펀딩을 넣어도 원본 코드가 높은 승률을 내는지 확인.

입력은 합성 데이터이며 수익성 결과가 아니다. 원본이 '예상 수익을 즉시 실현'으로 기록하는지 보이는 용도.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from csa_lab.original_runner import run_original  # noqa: E402

H = 3_600_000
T0 = 1_688_169_600_000  # 2023-07-01


def main(original_repo: str, out: str):
    n = 24 * 60
    rng = np.random.default_rng(0)
    p = 30000 * np.exp(np.cumsum(rng.normal(0, 0.004, n)))
    bars = pd.DataFrame({"binance_perp_open": p, "binance_perp_high": p * 1.002, "binance_perp_low": p * 0.998,
                         "binance_perp_close": p}, index=[T0 + i * H for i in range(n)])
    fb = pd.DataFrame({"ts": [T0 + i * 8 * H for i in range(n // 8)], "rate": 0.0003})
    fh = pd.DataFrame({"ts": [T0 + i * H for i in range(n)], "rate": 0.00001})
    r = run_original(Path(original_repo), bars, {"binance": fb, "hyperliquid": fh}, Path(out),
                     mode="full_backtest", start_date="2023-07-01", end_date="2023-08-29", timeout_s=1800)
    print(json.dumps({"synthetic_input": True, "exit_code": r["exit_code"], "produced": r["produced"]},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
