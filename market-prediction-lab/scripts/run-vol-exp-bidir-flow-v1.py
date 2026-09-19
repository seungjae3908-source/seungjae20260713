#!/usr/bin/env python3
from __future__ import annotations
import importlib.util, json, sys
from pathlib import Path

BASE_PATH=Path("market-prediction-lab/scripts/run-binance-orderflow-v1.py")
spec=importlib.util.spec_from_file_location("orderflow_base",BASE_PATH)
base=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=base
spec.loader.exec_module(base)

OUT=Path("market-prediction-lab/artifacts/vol-exp-bidir-flow-v1")
OUT.mkdir(parents=True,exist_ok=True)

def common_setup(b,F,i):
    if i<50 or not F["atr"][i] or not F["vma"][i]:return None
    hi,lo=base.roll_hilo(b,36,i);A=F["atr"][i];ap=A/b[i].c
    rv=b[i].v/F["vma"][i] if F["vma"][i] else 0
    if not (0.0035<=ap<=0.018) or (hi-lo)/b[i].c>0.012 or rv<1.0:return None
    return hi,lo,A,base.flow_ratio(b,i,12)

def long_flow(b,F,i):
    x=common_setup(b,F,i)
    if not x:return None
    hi,lo,A,fl=x
    if b[i].c<=hi or fl is None or fl<0.05:return None
    return {"side":1,"stop":min(b[i].l,hi-0.8*A),"rr":1.8,"hold":18,"flow":fl}

def short_flow(b,F,i):
    return base.sig_vol_base(b,F,i,True)

def bidir_flow(b,F,i):
    s=long_flow(b,F,i)
    if s:return s
    return short_flow(b,F,i)

STRATS={
 "VOL_EXP_LONG_FLOW":long_flow,
 "VOL_EXP_SHORT_FLOW":short_flow,
 "VOL_EXP_BIDIR_FLOW":bidir_flow,
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

    payload={"schemaVersion":1,"kind":"vol-exp-bidir-flow-v1","research_only":True,
             "public_data_only":True,"live_trading":False,"private_api":False,
             "orders_submitted":0,"leverage":1,
             "formula":{
               "structure":"same 36-bar compression / ATR / RVOL / RR / hold as frozen VOL_EXP_SHORT",
               "long":"upside breakout requires 12-bar signed taker flow >= +0.05",
               "short":"downside breakout requires 12-bar signed taker flow <= -0.05",
               "bidir":"takes whichever directional breakout qualifies; no parameter retuning",
             },
             "symbols":base.SYMBOLS,"months":base.MONTHS,"costs":base.COSTS,
             "provenance":prov,"results":results}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# VOL_EXP Bidirectional Flow V1","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
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
