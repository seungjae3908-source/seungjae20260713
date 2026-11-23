"""자동매매 자금 원장: 50% 재투자·50% 예비금, 손실 차감, 보충 없음, 중복 결산 금지, 원자 저장·재시작 복구·일관성."""
import json

import pytest

from csa_lab.fund import (AutoTradingFund, DuplicateSettlementError, EntryLimits, FundError,
                          LedgerInconsistentError)


def test_reinvest_half_reserve_half_and_losses():
    f = AutoTradingFund()
    assert f.base_balance_krw == 1_000_000 and f.reserve_krw == 0
    f.settle("t1", 10_000)
    assert f.base_balance_krw == 1_005_000 and f.reserve_krw == 5_000
    f.settle("t2", -30_000)
    assert f.base_balance_krw == 975_000 and f.reserve_krw == 5_000  # 손실은 기본 자금만 줄이고 보충 없음
    f.settle("t3", 0)
    assert f.base_balance_krw == 975_000 and f.reserve_krw == 5_000
    assert f.verify()["ok"]
    assert not hasattr(f, "transfer_reserve_to_base")  # 예비금 자동 이체 없음


def test_duplicate_settlement_rejected():
    f = AutoTradingFund()
    f.settle("t1", 100)
    with pytest.raises(DuplicateSettlementError):
        f.settle("t1", 100)
    assert f.base_balance_krw == 1_000_050


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), None, "10", True])
def test_bad_pnl_rejected(bad):
    with pytest.raises(FundError):
        AutoTradingFund().settle("x", bad)


def test_allowed_entry_margin_rules():
    f = AutoTradingFund(max_entry_margin_krw=1_000_000)
    assert f.allowed_entry_margin_krw()["allowed_krw"] == 1_000_000
    f.set_max_entry_margin(300_000)
    r = f.allowed_entry_margin_krw()
    assert r["allowed_krw"] == 300_000 and r["binding"] == "max_entry_margin"
    f.settle("loss", -800_000)  # 잔액 200,000
    r = f.allowed_entry_margin_krw()
    assert r["allowed_krw"] == 200_000 and r["binding"] == "base_balance"
    r = f.allowed_entry_margin_krw(limits=EntryLimits(exchange_available_krw=150_000))
    assert r["allowed_krw"] == 150_000 and r["binding"] == "exchange_available"
    r = f.allowed_entry_margin_krw(limits=EntryLimits(risk_max_margin_krw=50_000, exchange_min_order_krw=60_000))
    assert r["entry_blocked"] and r["allowed_krw"] == 0 and r["binding"] == "exchange_min_order"
    f.settle("big_profit", 2_000_000)  # 잔액 1,200,000, 예비금 1,000,000
    assert f.allowed_entry_margin_krw()["allowed_krw"] == 300_000  # 한도가 잔액보다 작으면 한도


def test_strategy_plans_share_one_pool():
    f = AutoTradingFund()
    f.allocate_plan("carry_binance", 500_000)
    f.allocate_plan("xvenue_funding", 500_000)
    with pytest.raises(FundError):
        f.allocate_plan("third", 1)  # 같은 100만원을 세 번째 전략이 또 쓸 수 없음
    assert f.allowed_entry_margin_krw("carry_binance")["allowed_krw"] == 500_000
    f.settle("l", -700_000)  # 잔액 300,000 < 계획 500,000
    r = f.allowed_entry_margin_krw("carry_binance")
    assert r["allowed_krw"] == 300_000 and r["binding"] == "base_balance"
    f.release_plan("third") if "third" in f.plans else None
    with pytest.raises(FundError):
        f.allowed_entry_margin_krw("unknown")


def test_persist_restart_recovery_and_tamper_detection(tmp_path):
    p = tmp_path / "fund.json"
    f = AutoTradingFund.open(p, max_entry_margin_krw=700_000)
    f.allocate_plan("a", 400_000)
    f.settle("t1", 20_000)
    f.settle("t2", -5_000)
    g = AutoTradingFund.open(p)  # 재시작 복구
    assert g.base_balance_krw == 1_005_000 and g.reserve_krw == 10_000 and g.max_entry_margin_krw == 700_000
    assert g.plans == {"a": 400_000} and set(g.settled) == {"t1", "t2"}
    with pytest.raises(DuplicateSettlementError):
        g.settle("t1", 20_000)
    d = json.loads(p.read_text())
    d["base_balance_krw"] += 1
    p.write_text(json.dumps(d))
    with pytest.raises(LedgerInconsistentError):
        AutoTradingFund.load(p)


def test_atomic_save_no_partial(tmp_path, monkeypatch):
    import os
    p = tmp_path / "fund.json"
    f = AutoTradingFund.open(p)
    good = p.read_text()

    def boom(*a, **k):
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        f.settle("t", 100)
    monkeypatch.undo()
    assert p.read_text() == good and not list(tmp_path.glob(".*.part"))
