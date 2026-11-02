"""원본 Phase 3 아이디어를 실제 손익으로 다시 계산하는 시간순 백테스트 엔진.

원본은 진입 시각에 '예상 수익'을 즉시 실현 손익으로 기록했다(보유 0시간, 펀딩 정산 없음).
여기서는 다음을 지킨다.
- 시각 T 의 판단은 T 이전에 끝난 봉 종가와 시각 T 이하 펀딩 공시만 사용한다.
- 체결은 판단 시각 T 에 시작하는 봉의 시가. 수수료·슬리피지·스프레드는 체결 명목가치에 별도 부과.
- 펀딩은 정산 시각에 포지션을 보유하고 있으면 실제 공시 비율로 정산(롱 지급/숏 수령, 부호 그대로).
- 무기한 선물 다리는 격리 증거금. 봉 고가/저가가 청산가에 닿으면 그 다리 증거금 전액 손실.
- 자본은 매 봉 종가로 평가(마크투마켓)해 MDD·Sharpe 를 계산한다.

전략
- carry_binance (원본 A '캘린더'에 해당): 바이낸스 현물 매수 + 무기한 매도. 펀딩 연환산 > 진입 기준이면 진입.
- xvenue_funding (원본 C '합성선물' / D '롤'에 해당): 바이낸스 vs 하이퍼리퀴드 무기한 펀딩 차이.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from typing import Optional

import numpy as np
import pandas as pd

from .costs import CostModel, UNKNOWN
from .fund import AutoTradingFund, EntryLimits
from .leverage import parse_leverage
from .margin import liquidation_price
from .metrics import HOURS_PER_YEAR, max_drawdown, sharpe, trade_stats

HOUR_MS = 3_600_000


class BacktestInputError(ValueError):
    pass


@dataclass(frozen=True)
class StrategyParams:
    name: str
    entry_annualized: float          # 진입 기준(연환산, 소수: 0.15 = 15%)
    exit_annualized: float           # 청산 기준
    max_hold_hours: Optional[int]    # 최대 보유 시간(None = 제한 없음)
    lookback_hours: int = 24         # 펀딩 평균 구간
    source_note: str = ""


# 원본 기준값: step4_futures_orchestrator.py 680/702행(캘린더 15%/-10%, 5% 차감),
# 755-813행(합성선물 차이 >= 10%, 30일 보유), 887행(롤 >10% 연환산).
CARRY_ORIGINAL = StrategyParams(
    "carry_binance", 0.15, 0.05, None, 24,
    "원본 캘린더: 평균 연환산 펀딩 > 15% 진입, 기대수익 계산에서 5% 차감 → 5% 미만이면 청산으로 해석")
XVENUE_ORIGINAL = StrategyParams(
    "xvenue_funding", 0.10, 0.0, 30 * 24, 24,
    "원본 합성선물/롤: 거래소 간 연환산 펀딩 차이 >= 10% 진입, 보유 30일. 청산 규칙은 원본에 없어 차이 소멸(0 이하) 또는 30일로 정함")
# 운영 앱이 실제로 낼 수 있는 조합(업비트 KRW 현물 롱 + 비트겟 USDT 무기한 숏)에 같은 캐리 규칙을 적용한 변형.
# 현물 가격은 같은 시각 업비트 KRW-USDT 1시간봉 종가로 USDT 환산하므로 김치 프리미엄 변동이 손익에 포함된다.
CARRY_UPBIT_BITGET = StrategyParams(
    "carry_upbit_bitget", 0.15, 0.05, None, 24,
    "캐리 규칙은 carry_binance 와 동일(연환산 비트겟 펀딩 > 15% 진입, < 5% 청산). 다리: 업비트 KRW-BTC(USDT 환산) 매수 + 비트겟 BTCUSDT 무기한 매도")

# 캐리 전략 계열: 이름 -> (현물 다리, 무기한 다리, 펀딩·무기한 거래소)
CARRY_LEGS = {
    "carry_binance": ("binance_spot", "binance_perp", "binance"),
    "carry_upbit_bitget": ("upbit_spot", "bitget_perp", "bitget"),
}


@dataclass
class LegSpec:
    leg: str          # 가격 열 접두어
    kind: str         # "perp" | "spot"
    venue: str
    side: int         # +1 롱, -1 숏
    funding_venue: Optional[str]
    mmr: Optional[float]


@dataclass
class OpenLeg:
    spec: LegSpec
    qty: float
    entry_price: float
    margin: float
    notional: float
    liq_price: Optional[float]
    funding_pnl: float = 0.0


@dataclass
class TradeRecord:
    strategy: str
    direction: str
    entry_ts: str
    exit_ts: str
    hold_hours: float
    leverage: int
    capital_at_entry: float
    legs: list
    gross_price_pnl: float
    fees_entry: float
    fees_exit: float
    funding_pnl: float
    slippage: float
    spread: float
    net_pnl: float
    exit_reason: str
    liquidated: bool


@dataclass
class MarketData:
    """시간 인덱스(봉 시작 시각, UTC ms) 기준 가격과 펀딩 공시."""

    bars: pd.DataFrame                 # index=ts, 열: {leg}_open/high/low/close, 선택 {leg}_mark_high/low/close
    funding: dict[str, pd.DataFrame]   # venue -> ts, rate, interval_hours
    price_proxies: dict = field(default_factory=dict)  # leg -> 설명(다른 거래소 가격을 대용했을 때)
    # 창별 품질 검사용 원천 프레임(정렬·중복 제거됨): 이름 -> {"frame": DataFrame, "source": str, "interval_ms": int, "kind": str}
    datasets: dict = field(default_factory=dict)

    def validate(self, legs: list[str]) -> None:
        validate_bars(self.bars, legs)


def leg_price_columns(legs: list[str]) -> list[str]:
    return [f"{leg}_{c}" for leg in legs for c in ("open", "high", "low", "close")]


def validate_bars(bars: pd.DataFrame, legs: list[str]) -> None:
    """봉 프레임이 비어 있지 않고, 시간이 증가 순서이며, 사용하는 다리의 OHLC 가 모두 양의 유한값인지 확인."""
    if bars.empty:
        raise BacktestInputError("가격 데이터가 비어 있습니다")
    idx = bars.index.to_numpy()
    if not (np.diff(idx) > 0).all():
        raise BacktestInputError("가격 시간이 증가 순서가 아니거나 중복이 있습니다")
    for col in leg_price_columns(legs):
        if col not in bars.columns:
            raise BacktestInputError(f"가격 열 없음: {col}")
        v = bars[col].to_numpy(dtype=float)
        if not np.isfinite(v).all() or (v <= 0).any():
            raise BacktestInputError(f"가격 열에 결측/0 이하 값: {col}")


def drop_bars_missing_legs(bars: pd.DataFrame, legs: list[str]) -> tuple[pd.DataFrame, list[str]]:
    """사용하는 다리의 OHLC 가 하나라도 결측(NaN)인 봉은 평가에서 제외한다. 채우거나 보간하지 않는다.

    반환: (남은 봉, 제외된 봉 시각 ISO 목록). 제외된 봉은 이후 결측 봉 수·최대 공백 검사에 그대로 반영된다."""
    cols = [c for c in leg_price_columns(legs) if c in bars.columns]
    if not cols or bars.empty:
        return bars, []
    keep = bars[cols].notna().all(axis=1)
    dropped = bars.index[~keep]
    if len(dropped) == 0:
        return bars, []
    iso = [pd.Timestamp(int(t), unit="ms", tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ") for t in dropped]
    return bars[keep], iso


def annualized_funding(funding: pd.DataFrame, t_ms: int, lookback_hours: int) -> tuple[Optional[float], Optional[int]]:
    """t_ms 이하로 공시된 펀딩만 사용한 연환산 평균. (값, 마지막 공시 ts)."""
    if funding is None or funding.empty:
        return None, None
    ts = funding["ts"].to_numpy()
    hi = int(np.searchsorted(ts, t_ms, side="right"))
    if hi == 0:
        return None, None
    lo = int(np.searchsorted(ts, t_ms - lookback_hours * HOUR_MS, side="right"))
    if lo >= hi:
        return None, int(ts[hi - 1])
    window = funding.iloc[lo:hi]
    per_year = (HOURS_PER_YEAR / window["interval_hours"].astype(float)).to_numpy()
    ann = float(np.mean(window["rate"].to_numpy(dtype=float) * per_year))
    return ann, int(ts[hi - 1])


def _funding_between(funding: pd.DataFrame, after_ms: int, upto_ms: int) -> list:
    """after_ms < ts <= upto_ms 인 펀딩 공시 비율 목록."""
    if funding is None or funding.empty:
        return []
    ts = funding["ts"].to_numpy()
    lo = int(np.searchsorted(ts, after_ms, side="right"))
    hi = int(np.searchsorted(ts, upto_ms, side="right"))
    return [float(x) for x in funding["rate"].iloc[lo:hi]]


def prepare_funding(df: pd.DataFrame, default_interval_hours: int) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=["ts", "rate", "interval_hours"])
    d = df.copy()
    d["ts"] = (d["ts"].astype("int64") // HOUR_MS) * HOUR_MS  # 정산 시각을 정시로
    if "interval_hours" not in d.columns:
        d["interval_hours"] = default_interval_hours
    d = d.sort_values("ts").drop_duplicates("ts", keep="last").reset_index(drop=True)
    return d[["ts", "rate", "interval_hours"]]


def _costs_for(notional: float, cost: CostModel, venue_fees: dict, venue: str, kind: str) -> tuple[float, float, float]:
    fee_rate = venue_fees.get(f"{venue}:{kind}")
    if fee_rate is None:
        fee_rate = cost.taker_fee.value
    if fee_rate is None or cost.slippage.value is None or cost.half_spread.value is None:
        raise BacktestInputError("비용이 UNKNOWN 이라 순손익 백테스트를 할 수 없습니다")
    return notional * fee_rate, notional * cost.slippage.value, notional * cost.half_spread.value


def run_backtest(market: MarketData, params: StrategyParams, *, leverage: int, capital: float,
                 cost: CostModel, venue_fees: dict, mmr: dict, start_ms: int, end_ms: int,
                 stale_funding_hours: dict, max_gap_hours: int = 6,
                 fund: Optional["AutoTradingFund"] = None, fund_fx_krw_per_unit: Optional[float] = None,
                 fund_strategy_id: Optional[str] = None, entry_limits: Optional["EntryLimits"] = None) -> dict:
    """한 전략·한 레버리지 백테스트. 결과 dict(거래 목록, 자본 곡선, 지표).

    fund 가 주어지면 자동매매 자금 규칙을 적용한다: 진입 증거금 = min(최대 진입 한도, 기본 자금 잔액, 전략 계획)
    (원화 → 증거금 통화는 fund_fx_krw_per_unit 로 환산), 거래마다 순손익을 원장에 한 번만 결산(이익 50% 재투자,
    50% 예비금, 손실은 기본 자금 차감). capital 은 장부상 현금의 시작값이며 fund 가 있으면 fund.base_balance 로 맞춘다.
    """
    lev = parse_leverage(leverage)
    if fund is not None:
        if fund_fx_krw_per_unit is None or not math.isfinite(fund_fx_krw_per_unit) or fund_fx_krw_per_unit <= 0:
            raise BacktestInputError("fund 를 쓰려면 양의 환율(fund_fx_krw_per_unit)이 필요합니다")
        capital = fund.base_balance_krw / fund_fx_krw_per_unit
    if not (isinstance(capital, (int, float)) and math.isfinite(capital) and capital > 0):
        raise BacktestInputError(f"자본이 잘못됐습니다: {capital!r}")
    is_carry = params.name in CARRY_LEGS
    if is_carry:
        spot_leg, perp_leg, carry_venue = CARRY_LEGS[params.name]
        legs_used = [spot_leg, perp_leg]
        spot_venue = spot_leg.split("_")[0]
    elif params.name == "xvenue_funding":
        legs_used = ["binance_perp", "hl_perp"]
        spot_leg = perp_leg = carry_venue = spot_venue = None
    else:
        raise BacktestInputError(f"알 수 없는 전략: {params.name}")
    for venue in ([carry_venue] if is_carry else ["binance", "hyperliquid"]):
        if venue not in stale_funding_hours:
            raise BacktestInputError(f"stale_funding_hours 에 {venue} 없음")
        if venue not in mmr:
            raise BacktestInputError(f"유지증거금률(mmr)에 {venue} 없음")
    bars = market.bars[(market.bars.index >= start_ms) & (market.bars.index < end_ms)]
    # 창 안에서 사용하는 다리의 가격이 결측인 봉은 제외한다(원천에 없는 봉을 만들어 내지 않음). 창 밖 결측은 이 창과 무관.
    bars, bars_dropped_missing_leg = drop_bars_missing_legs(bars, legs_used)
    if bars.empty:
        raise BacktestInputError("백테스트 구간에 사용하는 다리의 가격 봉이 없습니다")
    validate_bars(bars, legs_used)
    if len(bars) < 48:
        raise BacktestInputError("백테스트 구간 봉이 48개 미만입니다")
    expected = int((bars.index[-1] - bars.index[0]) // HOUR_MS) + 1
    missing_bars = expected - len(bars)
    gaps_h = np.diff(bars.index.to_numpy()) // HOUR_MS - 1
    max_gap_h = int(gaps_h.max()) if len(gaps_h) else 0
    if max_gap_h > max_gap_hours:
        raise BacktestInputError(f"백테스트 구간에 {max_gap_h}시간 연속 빠진 봉이 있습니다(허용 {max_gap_hours}시간)")

    fb = market.funding.get(carry_venue if is_carry else "binance")
    fh = market.funding.get("hyperliquid")

    cash = float(capital)
    legs: list[OpenLeg] = []
    pos_dir = 0
    entry_i = None
    entry_capital = 0.0
    trade_costs = {"fees_entry": 0.0, "fees_exit": 0.0, "slippage": 0.0, "spread": 0.0}
    trades: list[TradeRecord] = []
    fund_events: list = []
    equity_curve = np.empty(len(bars))
    blocked_stale = 0
    blocked_fund_entries = 0
    halted = False
    idx = bars.index.to_numpy()
    cols = {c: bars[c].to_numpy(dtype=float) for c in bars.columns}

    def px(leg: str, field_: str, i: int) -> float:
        return float(cols[f"{leg}_{field_}"][i])

    def mark_hilo(leg: str, i: int) -> tuple[float, float]:
        if f"{leg}_mark_high" in cols:
            return float(cols[f"{leg}_mark_low"][i]), float(cols[f"{leg}_mark_high"][i])
        return px(leg, "low", i), px(leg, "high", i)

    def close_all(i: int, price_field: str, reason: str, liquidated_leg: Optional[str] = None):
        nonlocal cash, legs, pos_dir, entry_i
        gross = 0.0
        fund_pnl = 0.0
        leg_rows = []
        for L in legs:
            if liquidated_leg is not None and L.spec.leg == liquidated_leg:
                # 격리 증거금 전액 손실(청산 수수료 포함으로 보수적 처리)
                pnl = -L.margin
                exit_price = L.liq_price
                f = s = sp = 0.0
            else:
                exit_price = px(L.spec.leg, price_field, i)
                pnl = L.spec.side * L.qty * (exit_price - L.entry_price)
                notional_exit = L.qty * exit_price
                f, s, sp = _costs_for(notional_exit, cost, venue_fees, L.spec.venue, L.spec.kind)
            trade_costs["fees_exit"] += f
            trade_costs["slippage"] += s
            trade_costs["spread"] += sp
            gross += pnl
            fund_pnl += L.funding_pnl
            cash += pnl - f - s - sp
            leg_rows.append({"leg": L.spec.leg, "venue": L.spec.venue, "kind": L.spec.kind, "side": L.spec.side,
                             "qty": L.qty, "entry_price": L.entry_price, "exit_price": exit_price,
                             "notional_entry": L.notional, "margin": L.margin, "liq_price": L.liq_price,
                             "funding_pnl": L.funding_pnl, "liquidated": liquidated_leg == L.spec.leg})
        exit_ts = int(idx[i]) + (HOUR_MS if price_field == "close" else 0)
        hold = (exit_ts - int(idx[entry_i])) / HOUR_MS
        net = gross + fund_pnl - sum(trade_costs.values())
        trades.append(TradeRecord(
            params.name, "short_high_long_low" if params.name == "xvenue_funding" else "long_spot_short_perp",
            pd.Timestamp(int(idx[entry_i]), unit="ms", tz="UTC").isoformat(),
            pd.Timestamp(exit_ts, unit="ms", tz="UTC").isoformat(), hold, lev, entry_capital, leg_rows,
            gross, trade_costs["fees_entry"], trade_costs["fees_exit"], fund_pnl, trade_costs["slippage"],
            trade_costs["spread"], net, reason, liquidated_leg is not None))
        if fund is not None:
            trade_id = f"{params.name}:lev{lev}:{int(idx[entry_i])}:{exit_ts}"
            rec = fund.settle(trade_id, net * fund_fx_krw_per_unit, note=reason)
            fund_events.append(rec)
        legs = []
        pos_dir = 0
        entry_i = None
        for k in trade_costs:
            trade_costs[k] = 0.0

    for i in range(len(bars)):
        T = int(idx[i])
        # 1) 펀딩 정산: 직전 봉 시각 이후 ~ T 사이 공시분(빠진 봉이 있어도 누락 없이), T 이전에 연 포지션만
        if i > 0 and legs:
            prev_T = int(idx[i - 1])
            for L in legs:
                if L.spec.funding_venue is None:
                    continue
                fdf = market.funding.get(L.spec.funding_venue)
                for rate in _funding_between(fdf, prev_T, T):
                    mark = float(cols.get(f"{L.spec.leg}_mark_close", cols[f"{L.spec.leg}_close"])[i - 1])
                    pay = -L.spec.side * L.qty * mark * rate
                    L.funding_pnl += pay
                    cash += pay

        # 2) 판단(시각 T 까지 공개된 정보만) 및 시가 체결
        if not halted:
            ann_b, last_b = annualized_funding(fb, T, params.lookback_hours)
            ann_h, last_h = (None, None)
            if params.name == "xvenue_funding":
                ann_h, last_h = annualized_funding(fh, T, params.lookback_hours)
            stale = False
            checks = [(carry_venue, last_b)] if is_carry else [("binance", last_b), ("hyperliquid", last_h)]
            for venue, last in checks:
                if last is None or T - last > stale_funding_hours[venue] * HOUR_MS:
                    stale = True
            if is_carry:
                signal = None if stale or ann_b is None else ann_b
                want_enter = signal is not None and signal > params.entry_annualized
                want_exit = pos_dir != 0 and (signal is not None and signal < params.exit_annualized)
                new_dir = 1
            else:
                if stale or ann_b is None or ann_h is None:
                    signal = None
                else:
                    signal = ann_b - ann_h  # >0: 바이낸스 펀딩이 높음 → 바이낸스 숏, HL 롱
                want_enter = signal is not None and abs(signal) > params.entry_annualized
                new_dir = (1 if (signal or 0) > 0 else -1)
                want_exit = pos_dir != 0 and signal is not None and pos_dir * signal <= params.exit_annualized
            if pos_dir != 0 and stale:
                want_exit = True
                exit_reason = "stale_data_exit"  # 데이터가 끊기면 보유 근거가 없으므로 정리
            elif pos_dir != 0 and params.max_hold_hours is not None and (i - entry_i) >= params.max_hold_hours:
                want_exit = True
                exit_reason = "max_hold"
            else:
                exit_reason = "signal_exit"
            just_exited = False
            if pos_dir != 0 and want_exit:
                close_all(i, "open", exit_reason)
                just_exited = True
            if pos_dir == 0 and stale:
                blocked_stale += 1  # 오래된/없는 펀딩 데이터로 신규 진입 차단
            if pos_dir == 0 and want_enter and not just_exited:
                if fund is None:
                    equity = cash
                else:
                    lim = fund.allowed_entry_margin_krw(fund_strategy_id, entry_limits)
                    equity = lim["allowed_krw"] / fund_fx_krw_per_unit if not lim["entry_blocked"] else 0.0
                    # 장부 현금(미재투자 이익 포함)보다 많이 쓸 수는 없다
                    equity = min(equity, cash)
                if equity <= 0 or (fund is None and equity <= capital * 0.01):
                    halted = fund is None
                    if fund is not None:
                        blocked_fund_entries += 1
                else:
                    if is_carry:
                        spot_notional = equity * lev / (lev + 1)
                        perp_margin = equity - spot_notional
                        specs = [(LegSpec(spot_leg, "spot", spot_venue, 1, None, None), spot_notional, spot_notional),
                                 (LegSpec(perp_leg, "perp", carry_venue, -1, carry_venue, mmr[carry_venue]),
                                  perp_margin, perp_margin * lev)]
                    else:
                        half = equity / 2.0
                        hi_venue, lo_venue = ("binance_perp", "hl_perp") if new_dir == 1 else ("hl_perp", "binance_perp")
                        def spec(leg, side):
                            venue = "binance" if leg == "binance_perp" else "hyperliquid"
                            return LegSpec(leg, "perp", venue, side, venue, mmr[venue])
                        specs = [(spec(hi_venue, -1), half, half * lev), (spec(lo_venue, 1), half, half * lev)]
                    # 진입 비용을 감당하도록 명목가치를 비용만큼 축소하지 않고 현금에서 차감(손익에 반영)
                    for sp_, margin, notional in specs:
                        price = px(sp_.leg, "open", i)
                        qty = notional / price
                        f, s, spr = _costs_for(notional, cost, venue_fees, sp_.venue, sp_.kind)
                        trade_costs["fees_entry"] += f
                        trade_costs["slippage"] += s
                        trade_costs["spread"] += spr
                        cash -= f + s + spr
                        liq = liquidation_price(sp_.side, price, lev, sp_.mmr) if sp_.kind == "perp" else None
                        legs.append(OpenLeg(sp_, qty, price, margin, notional, liq))
                    pos_dir = new_dir
                    entry_i = i
                    entry_capital = equity

        # 3) 봉 안 청산 확인(마크 가격 고가/저가가 있으면 사용)
        if legs:
            liq_leg = None
            for L in legs:
                if L.spec.kind != "perp" or L.liq_price is None or L.liq_price <= 0:
                    continue
                lo, hi = mark_hilo(L.spec.leg, i)
                if (L.spec.side == 1 and lo <= L.liq_price) or (L.spec.side == -1 and hi >= L.liq_price):
                    liq_leg = L.spec.leg
                    break
            if liq_leg is not None:
                close_all(i, "close", "liquidation", liquidated_leg=liq_leg)

        # 4) 종가 평가
        unreal = sum(L.spec.side * L.qty * (px(L.spec.leg, "close", i) - L.entry_price) for L in legs)
        equity_curve[i] = cash + unreal
        if equity_curve[i] <= 0 and legs:
            close_all(i, "close", "equity_depleted")
            equity_curve[i] = cash
            halted = True

    if legs:
        close_all(len(bars) - 1, "close", "end_of_data")
        equity_curve[-1] = cash

    rets = np.diff(equity_curve) / np.where(equity_curve[:-1] > 0, equity_curve[:-1], np.nan)
    rets = rets[np.isfinite(rets)]
    tstats = trade_stats([t.net_pnl for t in trades], [t.hold_hours for t in trades])
    gross_wins = sum(1 for t in trades if t.gross_price_pnl + t.funding_pnl > 0)
    total_fees = sum(t.fees_entry + t.fees_exit for t in trades)
    metrics = {
        "initial_capital": capital,
        "final_equity": float(equity_curve[-1]),
        "net_pnl": float(equity_curve[-1] - capital),
        "net_return": float(equity_curve[-1] / capital - 1.0),
        "gross_price_pnl": float(sum(t.gross_price_pnl for t in trades)),
        "funding_pnl": float(sum(t.funding_pnl for t in trades)),
        "gross_pnl_before_costs": float(sum(t.gross_price_pnl + t.funding_pnl for t in trades)),
        "gross_return_before_costs": float(sum(t.gross_price_pnl + t.funding_pnl for t in trades) / capital),
        "fees_entry": float(sum(t.fees_entry for t in trades)),
        "fees_exit": float(sum(t.fees_exit for t in trades)),
        "fees_total": float(total_fees),
        "slippage": float(sum(t.slippage for t in trades)),
        "spread": float(sum(t.spread for t in trades)),
        "max_drawdown": max_drawdown(equity_curve),
        "sharpe_hourly_annualized": sharpe(rets, HOURS_PER_YEAR),
        "sharpe_annualization": f"hourly mean/std * sqrt({HOURS_PER_YEAR})",
        "win_rate_gross_before_costs": (gross_wins / len(trades)) if trades else None,
        "liquidations": sum(1 for t in trades if t.liquidated),
        "max_notional_per_leg": float(max((l["notional_entry"] for t in trades for l in t.legs), default=0.0)),
        "bars": len(bars),
        "missing_bars_in_window": int(missing_bars),
        "bars_dropped_missing_leg": len(bars_dropped_missing_leg),
        "bars_dropped_missing_leg_ts": bars_dropped_missing_leg[:50],
        "max_gap_hours": max_gap_h,
        "blocked_stale_hours": blocked_stale,
        "halted": halted,
        "blocked_fund_entries": blocked_fund_entries,
        **tstats,
    }
    fund_summary = None
    if fund is not None:
        fund_summary = {"fx_krw_per_unit": fund_fx_krw_per_unit, "strategy_plan_id": fund_strategy_id,
                        "settlements": len(fund_events), "verify": fund.verify(),
                        "base_balance_krw": fund.base_balance_krw, "reserve_krw": fund.reserve_krw,
                        "max_entry_margin_krw": fund.max_entry_margin_krw, "plans": dict(fund.plans),
                        "note": "환율은 구간 시작값 하나를 고정 사용(환율 변동 손익은 반영하지 않음)"}
    return {
        "strategy": params.name,
        "params": asdict(params),
        "leverage": lev,
        "window": {"start": pd.Timestamp(int(idx[0]), unit="ms", tz="UTC").isoformat(),
                   "end_exclusive": pd.Timestamp(int(idx[-1]) + HOUR_MS, unit="ms", tz="UTC").isoformat()},
        "cost_model": cost.to_dict(),
        "venue_fees": venue_fees,
        "mmr": mmr,
        "price_proxies": market.price_proxies,
        "metrics": metrics,
        "fund": fund_summary,
        "trades": [asdict(t) for t in trades],
        "equity_curve_daily": [
            [pd.Timestamp(int(idx[j]), unit="ms", tz="UTC").isoformat(), float(equity_curve[j])]
            for j in range(0, len(bars), 24)
        ] + [[pd.Timestamp(int(idx[-1]) + HOUR_MS, unit="ms", tz="UTC").isoformat(), float(equity_curve[-1])]],
    }
