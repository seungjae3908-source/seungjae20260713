#!/usr/bin/env python3
"""Run the stage-five backtest while preserving unobserved funding as null.

The pinned shared recalc helper expects a numeric funding field. This adapter uses
0.0 only during arithmetic because funding is excluded from this old window, then
restores every trade to null and marks the aggregate as unobserved. It does not
create or claim a historical funding observation.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any


def load_stage5() -> ModuleType:
    path = Path(__file__).with_name("long_pullback_retest_backtest.py")
    spec = importlib.util.spec_from_file_location("stage5_long_pullback", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load stage-five backtest")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    stage5 = load_stage5()
    original_run_fold = stage5.run_fold

    def compatible_run_fold(
        stage3: ModuleType,
        *args: Any,
        **kwargs: Any,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        original_recalc = stage3.recalc

        def recalc_without_observed_funding(
            base_result: dict[str, Any],
            trades: list[dict[str, Any]],
        ) -> dict[str, Any]:
            unobserved = [trade for trade in trades if trade.get("funding_pnl_krw") is None]
            for trade in unobserved:
                trade["funding_pnl_krw"] = 0.0
            try:
                result = original_recalc(base_result, trades)
            finally:
                for trade in unobserved:
                    trade["funding_pnl_krw"] = None
                    trade["funding_observed"] = False
                    trade["funding_model"] = "EXCLUDED_UNAVAILABLE_FOR_WINDOW"
            result["total_funding_pnl_krw"] = None
            result["funding_observed"] = False
            result["funding_model"] = "EXCLUDED_UNAVAILABLE_FOR_WINDOW"
            return result

        stage3.recalc = recalc_without_observed_funding
        try:
            return original_run_fold(stage3, *args, **kwargs)
        finally:
            stage3.recalc = original_recalc

    stage5.run_fold = compatible_run_fold
    stage5.main()


if __name__ == "__main__":
    main()
