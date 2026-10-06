#!/usr/bin/env python3
from __future__ import annotations
import argparse,csv,json
from pathlib import Path

def load_one(root:Path,contract:str,market:str|None=None):
    found=[]
    for f in root.glob("**/summary.json"):
        try:d=json.loads(f.read_text(encoding="utf-8"))
        except Exception:continue
        if d.get("contract")==contract and (market is None or d.get("market")==market):
            found.append(d)
    if len(found)!=1: raise RuntimeError(f"EXPECTED_ONE:{contract}:{market}:got={len(found)}")
    return found[0]

def row(market,direction,candidate,h,f,gate):
    return {"market":market,"direction":direction,"candidate":candidate,"heldoutPass":gate["pass"],
            "heldoutReturn":h["totalReturn"],"heldoutMdd":h["mdd"],"heldoutPF":h["profitFactor"],"heldoutPositiveMonthRate":h["positiveMonthRate"],"heldoutTrades":h["tradeCount"],
            "threeYearReturn":f["totalReturn"],"threeYearMdd":f["mdd"],"threeYearPF":f["profitFactor"],"threeYearTrades":f["tradeCount"],
            **{f"{w}_return":f.get("windows",{}).get(w,{}).get("return") for w in ["1D","1W","1M","3M","6M","1Y","3Y"]},
            **{f"{w}_trades":f.get("windows",{}).get(w,{}).get("tradeCount") for w in ["1D","1W","1M","3M","6M","1Y","3Y"]}}

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--input-root",required=True);ap.add_argument("--out-dir",required=True);a=ap.parse_args()
    root=Path(a.input_root);out=Path(a.out_dir);out.mkdir(parents=True,exist_ok=True)
    kr=load_one(root,"hunter-kr-pressure-v3","KR_STOCK")
    us=load_one(root,"hunter-us-path-diagnostic-v4","US_STOCK")
    spot=load_one(root,"hunter-crypto-path-diagnostic-v4","CRYPTO_SPOT")
    fut=load_one(root,"hunter-crypto-path-diagnostic-v4","CRYPTO_FUTURES")
    rows=[]
    ks=kr["selected"];rows.append(row("KR_STOCK","LONG",ks["candidate"],ks["heldoutLastYear"],ks["observedThreeYear"],ks["heldoutGate"]))
    rows.append(row("US_STOCK","LONG",us["candidate"],us["heldoutLastYear"],us["observedThreeYear"],us["heldoutGate"]))
    rows.append(row("CRYPTO_SPOT","LONG"," + ".join(spot["candidateSet"]),spot["heldoutLastYear"],spot["observedThreeYear"],spot["heldoutGate"]))
    rows.append(row("CRYPTO_FUTURES","LONG+SHORT"," + ".join(fut["candidateSet"]),fut["heldoutLastYear"],fut["observedThreeYear"],fut["heldoutGate"]))
    with (out/"v4-final-table.csv").open("w",newline="",encoding="utf-8-sig") as fp:
        w=csv.DictWriter(fp,fieldnames=list(rows[0].keys()));w.writeheader();w.writerows(rows)
    result={"schemaVersion":1,"contract":"hunter-v4-path-final","rows":rows,"passRows":[r for r in rows if r["heldoutPass"]],
            "truthBoundary":{"KRUsesDailyV3":True,"USUsesChronological1m":True,"CryptoUsesChronological15m":True,"heldoutUsedForSelection":False,"executionAuthority":"NONE"}}
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(result,ensure_ascii=False),flush=True)
if __name__=="__main__":main()
