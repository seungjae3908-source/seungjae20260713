#!/usr/bin/env python3
from __future__ import annotations
import importlib.util, json, sys
from pathlib import Path

BASE_PATH=Path("market-prediction-lab/scripts/run-binance-orderflow-v1.py")
spec=importlib.util.spec_from_file_location("orderflow_v1",BASE_PATH)
base=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=base
spec.loader.exec_module(base)

OUT=Path("market-prediction-lab/artifacts/vol-exp-flow-economics-v2")
OUT.mkdir(parents=True,exist_ok=True)

def latest_known_funding(funding,t):
    last=None
    for ts,r in funding:
        if ts<=t:last=r
        else:break
    return last

def simulate_policy(bars,funding,F,cost,require_funding_alignment=False,require_cost_edge=False):
    eq=1.0;peak=1.0;mdd=0.0;trades=[];i=60
    while i<len(bars)-2:
        s=base.sig_vol_base(bars,F,i,True)
        if not s:
            i+=1;continue
        ei=i+1;entry=bars[ei].o
        risk=entry-s["stop"] if s["side"]>0 else s["stop"]-entry
        if risk<=0 or risk/entry<0.001 or risk/entry>0.05:
            i+=1;continue

        known=latest_known_funding(funding,bars[i].t)
        if require_funding_alignment and s["side"]<0 and (known is None or known<0):
            i+=1;continue

        gross_target=s["rr"]*risk/entry
        if require_cost_edge and gross_target<=2*cost:
            i+=1;continue

        tp=entry+s["side"]*s["rr"]*risk
        xi=min(ei+s["hold"]-1,len(bars)-1);exitp=bars[xi].c;reason="TIME"
        for k in range(ei,xi+1):
            x=bars[k]
            if s["side"]>0:
                if x.l<=s["stop"]:exitp=s["stop"];xi=k;reason="SL";break
                if x.h>=tp:exitp=tp;xi=k;reason="TP";break
            else:
                if x.h>=s["stop"]:exitp=s["stop"];xi=k;reason="SL";break
                if x.l<=tp:exitp=tp;xi=k;reason="TP";break

        gross=s["side"]*(exitp/entry-1)
        fc=base.fund_cost(funding,s["side"],bars[ei].t,bars[xi].t)
        net=gross-2*cost-fc
        eq*=max(0.01,1+net);peak=max(peak,eq);mdd=min(mdd,eq/peak-1)
        trades.append({"net":net,"gross":gross,"funding":fc,"known_funding":known,
                       "target_gross":gross_target,"side":s["side"],"flow":s.get("flow"),"reason":reason})
        i=xi+1
    wins=[t for t in trades if t["net"]>0];loss=[t for t in trades if t["net"]<0]
    gp=sum(t["net"] for t in wins);gl=-sum(t["net"] for t in loss)
    return {"trades":len(trades),"return":eq-1,"mdd":mdd,"pf":gp/gl if gl else None,
            "win_rate":len(wins)/len(trades) if trades else 0,
            "avg_net":sum(t["net"] for t in trades)/len(trades) if trades else 0,
            "funding_sum":sum(t["funding"] for t in trades),
            "known_funding_nonnegative":sum(1 for t in trades if t["known_funding"] is not None and t["known_funding"]>=0)}

POLICIES={
 "FLOW_CONFIRM":(False,False),
 "FLOW_CONFIRM_FUNDING_ALIGNED":(True,False),
 "FLOW_CONFIRM_COST_AWARE":(False,True),
 "FLOW_CONFIRM_FUNDING_AND_COST":(True,True),
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
    for name,(align,cost_edge) in POLICIES.items():
        results[name]={}
        for cname,cost in base.COSTS.items():
            by={s:simulate_policy(*data[s],cost,align,cost_edge) for s in base.SYMBOLS}
            results[name][cname]={"portfolio":base.portfolio(by),"symbols":by}

    payload={"schemaVersion":1,"kind":"vol-exp-flow-economics-v2",
             "research_only":True,"public_data_only":True,"live_trading":False,
             "private_api":False,"orders_submitted":0,"leverage":1,
             "formula":{
               "base_signal":"frozen VOL_EXP_SHORT plus 12-bar signed taker-flow confirmation",
               "funding_alignment":"SHORT requires latest funding observation known at signal time >= 0",
               "cost_aware":"target gross distance must exceed modeled round-trip trading cost",
               "variants":list(POLICIES),
             },
             "symbols":base.SYMBOLS,"months":base.MONTHS,"costs":base.COSTS,
             "provenance":prov,"results":results}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")

    lines=["# VOL_EXP Flow Economics V2","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           "| Strategy | Cost | Trades | EW return | Positive | Avg MDD | Median PF |",
           "|---|---|---:|---:|---:|---:|---:|"]
    for name in POLICIES:
        for cname in base.COSTS:
            p=results[name][cname]["portfolio"]
            pf="NA" if p["median_symbol_pf"] is None else f'{p["median_symbol_pf"]:.3f}'
            lines.append(f'| {name} | {cname} | {p["trades"]} | {p["equal_weight_return"]*100:.2f}% | {p["positive_symbols"]}/8 | {p["avg_mdd"]*100:.2f}% | {pf} |')
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":main()
