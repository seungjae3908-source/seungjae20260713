#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {reportFourMarketPITRosterReadinessV1} from "../src/historical-pit-venue-universe-gate-v1.js";
const path=resolve(process.argv[2]??
 "market-prediction-lab/docs/native-selected-historical-day-v1.json");
const output=resolve(process.argv[3]??
 "market-prediction-lab/docs/historical-pit-universe-readiness-v1.json");
const report=reportFourMarketPITRosterReadinessV1({
 nativeSelectedSummary:JSON.parse(readFileSync(path,"utf8")),
 // No authorized dated PIT archive is connected to this research runner.
 // NEVER derive historical archive memberships from surviving 2026 tickers.
 manifests:{},
});
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(report,null,2)+"\n",{encoding:"utf8",mode:0o600});
process.stdout.write(JSON.stringify({
 status:report.status,
 selectedSourceSymbolDays:report.observedSelectedSymbolDays,
 historicalMarketMemberCount:report.totalHistoricActiveMarketSymbols,
 markets:Object.fromEntries(Object.entries(report.markets).map(([key,value])=>[
  key,{status:value.status,reason:value.reason,
    knownSelectedSourceSymbolDays:value.observedSelectedSourceSymbolDays??0,
    originalMarketMemberCount:value.verifiedHistoricalMarketDenominator,
  }])),
 profitabilityProven:false,executionAuthority:"NONE",
})+"\n");
