"""비트겟 BTCUSDT·ETHUSDT 계약의 공개 레버리지 범위를 읽어 JSON 으로 남긴다(조회 전용, 주문·계정 없음).

사용: python scripts/bitget_leverage_evidence.py <출력 json>
네트워크가 막히면 status=BLOCKED_NETWORK 로 기록하고 종료 코드 3.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from csa_lab.data.bitget import contract_leverage_evidence  # noqa: E402
from csa_lab.http import PublicHttpClient, RetryPolicy  # noqa: E402
from csa_lab.storage import atomic_write_json  # noqa: E402


def main(out: str) -> int:
    client = PublicHttpClient(RetryPolicy(max_attempts=3, base_delay=1.0), min_interval=0.5)
    result = {"symbols": {}, "http_stats": None, "status": "OK"}
    rc = 0
    for sym in ("BTCUSDT", "ETHUSDT"):
        try:
            result["symbols"][sym] = contract_leverage_evidence(client, sym)
        except Exception as e:  # noqa: BLE001
            result["symbols"][sym] = {"status": "BLOCKED_NETWORK", "error": f"{type(e).__name__}: {e}"[:300]}
            result["status"] = "BLOCKED_NETWORK"
            rc = 3
    result["http_stats"] = client.stats.__dict__
    atomic_write_json(Path(out), result)
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
