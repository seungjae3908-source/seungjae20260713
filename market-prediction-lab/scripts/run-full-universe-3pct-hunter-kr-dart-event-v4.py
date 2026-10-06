#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import re
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import polars as pl

ROOT = Path(__file__).resolve().parents[2]
KR_V3_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-kr-event-v3.py"
SPEC = importlib.util.spec_from_file_location("kr_event_v3", KR_V3_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("KR_V3_IMPORT_FAILED")
krv3 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(krv3)
v1 = krv3.v1

START = pd.Timestamp("2023-04-01").date()
TRAIN_END = pd.Timestamp("2025-04-01").date()
VALID_END = pd.Timestamp("2026-04-01").date()
OOS_END = pd.Timestamp("2026-10-01").date()
CATALOG_URL = "https://huggingface.co/datasets/eddmpython/dartlab-data/resolve/main/dart/searchCatalog/allFilings/allFilings.catalog_snapshot.parquet"

FAMILIES = ("CONTRACT","BUYBACK","BONUS","INVEST_POS","CLINICAL")
RVOL_MINS = (1.0, 1.5, 2.5)
RET_MINS = (-0.02, 0.00, 0.03)
TOP_NS = (1, 3)
TARGETS = (0.03, 0.05)
STOPS = (0.02, 0.03)
HOLDS = (1, 3)
COST = 0.003

CORRECTION_PREFIXES = ("[기재정정]","[첨부추가]","[연장결정]","[정정]")
POSITIVE_WORDS = (
    "승인","허가","수주","계약","선정","기술이전","라이선스","공급",
    "FDA","MFDS","식약처","품목허가","임상시험계획","IND","특허",
)
CLINICAL_WORDS = ("임상","IND","FDA","MFDS","식약처","품목허가","신약")


def load_filing_catalog() -> pd.DataFrame:
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    q = f"""
      SELECT
        trim(stockCode) AS stockCode,
        date,
        trim(reportName) AS reportName,
        coalesce(searchText, '') AS searchText,
        rceptNo
      FROM read_parquet('{CATALOG_URL}')
      WHERE coalesce(deleted,false)=false
        AND date >= '20230401' AND date < '20261001'
        AND stockCode IS NOT NULL AND trim(stockCode) <> ''
    """
    df = con.execute(q).df()
    con.close()
    df["stockCode"] = df["stockCode"].astype(str).str.zfill(6)
    df["eventDate"] = pd.to_datetime(df["date"], format="%Y%m%d", errors="coerce").dt.date
    return df.dropna(subset=["eventDate","stockCode"])


def classify_event(report: str, search_text: str) -> str | None:
    r = str(report or "").strip()
    t = str(search_text or "")
    if any(r.startswith(p) for p in CORRECTION_PREFIXES):
        return None
    if ("단일판매" in r or "공급계약체결" in r) and "해지" not in r:
        return "CONTRACT"
    if ("자기주식취득결정" in r or "자기주식취득신탁계약체결결정" in r) and "해지" not in r:
        return "BUYBACK"
    if "무상증자결정" in r:
        return "BONUS"
    if "투자판단관련주요경영사항" in r:
        both = f"{r} {t}"
        if any(w in both for w in CLINICAL_WORDS) and any(w in both for w in POSITIVE_WORDS):
            return "CLINICAL"
        if any(w in both for w in POSITIVE_WORDS):
            return "INVEST_POS"
    return None


def prepare_events() -> tuple[pd.DataFrame, dict]:
    raw = load_filing_catalog()
    raw["family"] = [
        classify_event(r, t)
        for r, t in zip(raw["reportName"], raw["searchText"])
    ]
    x = raw[raw["family"].notna()].copy()
    x = x.sort_values(["eventDate","stockCode","rceptNo"])
    x = x.drop_duplicates(["eventDate","stockCode","family"], keep="first")
    counts = (
        x.groupby("family")
        .agg(events=("stockCode","size"),symbols=("stockCode","nunique"))
        .reset_index()
        .to_dict("records")
    )
    return x, {"rawFilings":len(raw),"classifiedEvents":len(x),"familyCounts":counts}


def add_price_features(raw: pl.DataFrame) -> pd.DataFrame:
    x = raw.sort(["symbol","date"]).with_columns([
        pl.col("close").shift(1).over("symbol").alias("prev_close"),
        pl.col("close").shift(5).over("symbol").alias("close_5ago"),
        pl.col("volume").shift(1).rolling_mean(20, min_samples=10).over("symbol").alias("priorVol20"),
        (pl.col("close").shift(1) * pl.col("volume").shift(1))
            .rolling_mean(20, min_samples=10).over("symbol").alias("priorDollar20"),
    ]).with_columns([
        (pl.col("close") / pl.col("prev_close") - 1.0).alias("eventDayReturn"),
        (pl.col("volume") / pl.col("priorVol20")).alias("eventRvol"),
        (pl.col("close") / pl.col("close_5ago") - 1.0).alias("mom5"),
    ])
    pdf = x.to_pandas()
    pdf["date"] = pd.to_datetime(pdf["date"]).dt.date
    return pdf


def attach_price_context(events: pd.DataFrame, price: pd.DataFrame):
    groups = {}
    rows = []
    for symbol, g in price.groupby("symbol", sort=False):
        g = g.sort_values("date").reset_index(drop=True)
        groups[str(symbol)] = g

    for e in events.itertuples(index=False):
        symbol = str(e.stockCode)
        g = groups.get(symbol)
        if g is None or g.empty:
            continue
        dates = np.array(g["date"].tolist(), dtype=object)
        cutoff_i = int(np.searchsorted(dates, e.eventDate, side="right") - 1)
        entry_i = int(np.searchsorted(dates, e.eventDate, side="right"))
        if cutoff_i < 20 or entry_i >= len(g):
            continue
        cutoff = g.iloc[cutoff_i]
        entry = g.iloc[entry_i]
        if (e.eventDate - cutoff["date"]).days > 7:
            continue
        if (entry["date"] - e.eventDate).days > 7:
            continue
        vals = [cutoff.get("eventDayReturn"),cutoff.get("eventRvol"),cutoff.get("mom5"),cutoff.get("priorDollar20")]
        if any(pd.isna(v) for v in vals):
            continue
        if float(entry["open"]) < 1000 or float(cutoff["priorDollar20"]) < 1_000_000_000:
            continue
        rows.append({
            "stockCode":symbol,
            "family":e.family,
            "eventDate":e.eventDate,
            "reportName":e.reportName,
            "rceptNo":e.rceptNo,
            "cutoffDate":cutoff["date"],
            "entryDate":entry["date"],
            "entryIndex":entry_i,
            "eventDayReturn":float(cutoff["eventDayReturn"]),
            "eventRvol":float(cutoff["eventRvol"]),
            "mom5":float(cutoff["mom5"]),
            "priorDollar20":float(cutoff["priorDollar20"]),
        })
    if not rows:
        raise RuntimeError("KR_DART_V4_NO_TRADABLE_EVENTS")
    return pd.DataFrame(rows), groups


def rank_top(x: pd.DataFrame, top_n: int) -> pd.DataFrame:
    if x.empty:
        return x
    y=x.copy()
    y["r1"]=y.groupby("entryDate")["eventDayReturn"].rank(method="average",ascending=False)
    y["r2"]=y.groupby("entryDate")["eventRvol"].rank(method="average",ascending=False)
    y["r3"]=y.groupby("entryDate")["priorDollar20"].rank(method="average",ascending=False)
    y["r4"]=y.groupby("entryDate")["mom5"].rank(method="average",ascending=False)
    y["score"]=-(y["r1"]+y["r2"]+y["r3"]+y["r4"])
    return (
        y.sort_values(["entryDate","score","stockCode"],ascending=[True,False,True])
         .groupby("entryDate",group_keys=False)
         .head(top_n)
    )


def simulate(row, groups, target: float, stop: float, hold: int, name: str):
    g=groups.get(row.stockCode)
    if g is None:
        return None
    i=int(row.entryIndex)
    end=min(i+hold-1,len(g)-1)
    future=g.iloc[i:end+1]
    if future.empty:
        return None
    entry=float(future.iloc[0]["open"])
    stop_px=entry*(1-stop)
    target_px=entry*(1+target)
    exit_px=float(future.iloc[-1]["close"])
    exit_reason="MAX_HOLD"
    exit_date=future.iloc[-1]["date"]
    for _,bar in future.iterrows():
        if float(bar["low"]) <= stop_px:
            exit_px=stop_px; exit_reason="STOP"; exit_date=bar["date"]; break
        if float(bar["high"]) >= target_px:
            exit_px=target_px; exit_reason="TARGET"; exit_date=bar["date"]; break
    gross=exit_px/entry-1
    return {
        "market":"KR_STOCK","direction":"LONG","candidate":name,
        "date":row.entryDate,"symbol":row.stockCode,"family":row.family,
        "eventDate":row.eventDate,"reportName":row.reportName,"rceptNo":row.rceptNo,
        "entryPrice":entry,"exitPrice":exit_px,"grossReturn":gross,
        "roundTripCost":COST,"netReturn":gross-COST,
        "MFE":float(future["high"].max())/entry-1,
        "MAE":1-float(future["low"].min())/entry,
        "exitDate":exit_date,"exitReason":exit_reason,
        "eventDayReturn":row.eventDayReturn,"eventRvol":row.eventRvol,
        "mom5":row.mom5,"priorDollar20":row.priorDollar20,
        "targetPct":target,"stopPct":stop,"holdDays":hold,
    }


def calc_metrics(trades, dates):
    if not trades:
        empty=pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
        return v1.metrics(empty,"KR_STOCK",dates)
    df=pl.DataFrame(trades).with_columns(pl.col("date").cast(pl.Date))
    return v1.metrics(df,"KR_STOCK",dates)


def gate(m,min_trades):
    checks={
        "positiveReturn":float(m.get("totalReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
        "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.50,
        "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
        "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}


def rank_key(m,name):
    return (
        float(m.get("positiveMonthRate") or 0),
        float(m.get("totalReturn") or 0),
        float(m.get("profitFactor") or 0),
        -float(m.get("mdd") or 0),
        int(m.get("tradeCount") or 0),
        name,
    )


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    events,event_audit=prepare_events()
    raw,source=krv3.load_kr_extended()
    price=add_price_features(raw)
    base,groups=attach_price_context(events,price)

    all_dates=sorted(price["date"].drop_duplicates().tolist())
    train_dates=[d for d in all_dates if START<=d<TRAIN_END]
    valid_dates=[d for d in all_dates if TRAIN_END<=d<VALID_END]
    oos_dates=[d for d in all_dates if VALID_END<=d<OOS_END]

    reports={}; grid=[]
    for family in FAMILIES:
        fam=base[base["family"]==family]
        for rv in RVOL_MINS:
            for ret_min in RET_MINS:
                filt=fam[(fam["eventRvol"]>=rv)&(fam["eventDayReturn"]>=ret_min)]
                for top_n in TOP_NS:
                    selected=rank_top(filt,top_n)
                    for target in TARGETS:
                        for stop in STOPS:
                            for hold in HOLDS:
                                name=f"KR_DART_{family}_RV{rv:g}_RET{ret_min:+.2f}_TOP{top_n}_TP{int(target*100)}_SL{int(stop*100)}_H{hold}"
                                trades=[]
                                for row in selected.itertuples(index=False):
                                    t=simulate(row,groups,target,stop,hold,name)
                                    if t is not None: trades.append(t)
                                train=[t for t in trades if t["date"]<TRAIN_END]
                                valid=[t for t in trades if TRAIN_END<=t["date"]<VALID_END]
                                oos=[t for t in trades if VALID_END<=t["date"]<OOS_END]
                                mt=calc_metrics(train,train_dates); mv=calc_metrics(valid,valid_dates); mo=calc_metrics(oos,oos_dates)
                                gt,gv,go=gate(mt,30),gate(mv,15),gate(mo,8)
                                reports[name]={"family":family,"train":mt,"validation":mv,"freshOos":mo,"trainGate":gt,"validationGate":gv,"freshOosGate":go,"trades":trades}
                                grid.append({
                                    "candidate":name,"family":family,"rvolMin":rv,"eventReturnMin":ret_min,"topN":top_n,"targetPct":target,"stopPct":stop,"holdDays":hold,
                                    "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                                    "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                                    "freshOosPass":go["pass"],"freshOosReturn":mo.get("totalReturn"),"freshOosPF":mo.get("profitFactor"),"freshOosMDD":mo.get("mdd"),"freshOosPosMonthRate":mo.get("positiveMonthRate"),"freshOosTrades":mo.get("tradeCount"),
                                })

    train_pass=[n for n,d in reports.items() if d["trainGate"]["pass"]]
    valid_pass=[n for n in train_pass if reports[n]["validationGate"]["pass"]]
    winner=sorted(valid_pass,key=lambda n:rank_key(reports[n]["validation"],n),reverse=True)[0] if valid_pass else None

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    summary={
        "schemaVersion":1,
        "contract":"full-universe-3pct-hunter-kr-dart-event-v4",
        "periods":{"train":[str(START),str(TRAIN_END)],"validation":[str(TRAIN_END),str(VALID_END)],"freshOos":[str(VALID_END),str(OOS_END)]},
        "eventAudit":event_audit,
        "tradableEventRows":len(base),
        "candidateCount":len(grid),
        "trainPassCount":len(train_pass),
        "validationPassCount":len(valid_pass),
        "winner":winner,
        "source":source,
        "truthBoundary":{
            "entryAlwaysFirstTradingDayAfterFilingDate":True,
            "filingTimeUnavailableSoSameDayEntryForbidden":True,
            "correctionsAndAttachmentUpdatesExcludedFromPrimarySignals":True,
            "freshOosUsedForSelection":False,
            "executionAuthority":"NONE",
        },
    }
    if winner:
        d=reports[winner]
        summary["winnerResults"]={"train":d["train"],"validation":d["validation"],"freshOos":d["freshOos"],"freshOosGate":d["freshOosGate"]}
        pd.DataFrame(d["trades"]).to_csv(out/"winner-ledger.csv",index=False)
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
