#!/usr/bin/env python3
from __future__ import annotations
import argparse,csv,json
from pathlib import Path

WINDOWS=("1D","1W","1M","3M","6M","1Y","3Y")

def add_row(rows,market,direction,sel):
    h=sel["heldoutLastYear"]; f=sel["observedThreeYear"]
    row={"market":market,"direction":direction,"candidate":sel["candidate"],"heldoutPass":sel["heldoutGate"]["pass"],
         "heldoutReturn":h["totalReturn"],"heldoutMdd":h["mdd"],"heldoutPF":h["profitFactor"],"heldoutPositiveMonthRate":h["positiveMonthRate"],"heldoutTrades":h["tradeCount"],
         "threeYearReturn":f["totalReturn"],"threeYearMdd":f["mdd"],"threeYearPF":f["profitFactor"],"threeYearTrades":f["tradeCount"]}
    for w in WINDOWS:
        row[f"{w}_return"]=(f.get("windows") or {}).get(w,{}).get("return")
        row[f"{w}_trades"]=(f.get("windows") or {}).get(w,{}).get("tradeCount")
    rows.append(row)

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--input-root",required=True);ap.add_argument("--out-dir",required=True);a=ap.parse_args()
    root=Path(a.input_root);out=Path(a.out_dir);out.mkdir(parents=True,exist_ok=True)
    summaries={}
    for f in root.glob("**/summary.json"):
        try:d=json.loads(f.read_text(encoding="utf-8"))
        except Exception:continue
        market=d.get("market")
        if market:summaries[market]=d
    missing=[m for m in ["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"] if m not in summaries]
    if missing:raise RuntimeError("MISSING_V3_MARKETS:"+",".join(missing))
    rows=[]
    for m in ["KR_STOCK","US_STOCK"]:
        add_row(rows,m,"LONG",summaries[m]["selected"])
    for m in ["CRYPTO_SPOT","CRYPTO_FUTURES"]:
        for d,s in summaries[m]["selectedByDirection"].items():add_row(rows,m,d,s)
    with (out/"v3-final-table.csv").open("w",newline="",encoding="utf-8-sig") as fp:
        wr=csv.DictWriter(fp,fieldnames=list(rows[0].keys()));wr.writeheader();wr.writerows(rows)
    result={"schemaVersion":1,"contract":"hunter-v3-final-combined","rows":rows,"passRows":[r for r in rows if r["heldoutPass"]],
            "marketPass":{"KR_STOCK":rows[0]["heldoutPass"],"US_STOCK":rows[1]["heldoutPass"],"CRYPTO_SPOT":any(r["market"]=="CRYPTO_SPOT" and r["heldoutPass"] for r in rows),"CRYPTO_FUTURES":any(r["market"]=="CRYPTO_FUTURES" and r["heldoutPass"] for r in rows)},
            "truthBoundary":{"heldoutUsedForSelection":False,"profitabilityProven":False,"executionAuthority":"NONE"}}
    (out/"combined-summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(result,ensure_ascii=False),flush=True)
if __name__=="__main__":main()
