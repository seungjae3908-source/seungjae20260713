#!/usr/bin/env python3
from __future__ import annotations
import importlib.util, json, sys
from pathlib import Path

BASE_PATH=Path("market-prediction-lab/scripts/run-binance-orderflow-v1.py")
spec=importlib.util.spec_from_file_location("orderflow_base",BASE_PATH)
base=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=base
spec.loader.exec_module(base)

OUT=Path("market-prediction-lab/artifacts/vol-exp-flow-robustness-v3")
OUT.mkdir(parents=True,exist_ok=True)

def raw_signal(b,F,i):
    return base.sig_vol_base(b,F,i,False)

def threshold_signal(b,F,i):
    return base.sig_vol_base(b,F,i,True)

def sign_signal(b,F,i):
    s=raw_signal(b,F,i)
    if not s:return None
    fl=base.flow_ratio(b,i,12)
    if fl is None or fl>=0:return None
    return {**s,"flow":fl}

def acceleration_signal(b,F,i):
    s=raw_signal(b,F,i)
    if not s or i<24:return None
    cur=base.flow_ratio(b,i,12)
    prev=base.flow_ratio(b,i-12,12)
    if cur is None or prev is None or cur>=0 or cur>=prev:return None
    return {**s,"flow":cur,"prev_flow":prev}

STRATS={
 "FLOW_THRESHOLD_M005":threshold_signal,
 "FLOW_SIGN_ONLY":sign_signal,
 "FLOW_SIGN_ACCELERATING":acceleration_signal,
}

def main():
    data={};prov={}
    for sym in base.SYMBOLS:
        bars,funding,kchk,fchk=base.load(sym)
        data[sym]=(bars,funding,base.features(bars))
        prov[sym]={"bars":len(bars),"funding_rows":len(funding),"funding_status":"BINANCE_VISION_OK",
                   "kline_sha256":kchk,"funding_sha256":fchk}
        print(json.dumps({"loaded":sym,"bars":len(bars),"funding":len(funding)}),flush=True)
    results={}
    for name,fn in STRATS.items():
        results[name]={}
        for cname,cost in base.COSTS.items():
            by={s:base.simulate(*data[s],fn,cost) for s in base.SYMBOLS}
            results[name][cname]={"portfolio":base.portfolio(by),"symbols":by}

    payload={"schemaVersion":1,"kind":"vol-exp-flow-robustness-v3",
             "research_only":True,"public_data_only":True,"live_trading":False,
             "private_api":False,"orders_submitted":0,"leverage":1,
             "formula":{
               "base_signal":"same frozen VOL_EXP_SHORT price structure",
               "FLOW_THRESHOLD_M005":"12-bar signed taker flow <= -0.05",
               "FLOW_SIGN_ONLY":"12-bar signed taker flow < 0; no magnitude threshold",
               "FLOW_SIGN_ACCELERATING":"flow < 0 and current 12-bar flow < preceding non-overlapping 12-bar flow",
               "selection_rule":"pre-registered robustness comparison; do not select by best backtest alone",
             },
             "symbols":base.SYMBOLS,"months":base.MONTHS,"costs":base.COSTS,
             "provenance":prov,"results":results}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# VOL_EXP Flow Robustness V3","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           "| Strategy | Cost | Trades | EW return | Positive | Avg MDD | Median PF |",
           "|---|---|---:|---:|---:|---:|---:|"]
    for name in STRATS:
        for cname in base.COSTS:
            p=results[name][cname]["portfolio"]
            pf="NA" if p["median_symbol_pf"] is None else f'{p["median_symbol_pf"]:.3f}'
            lines.append(f'| {name} | {cname} | {p["trades"]} | {p["equal_weight_return"]*100:.2f}% | {p["positive_symbols"]}/8 | {p["avg_mdd"]*100:.2f}% | {pf} |')
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))
if __name__=="__main__":main()
