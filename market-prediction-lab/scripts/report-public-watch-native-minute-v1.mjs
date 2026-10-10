#!/usr/bin/env node
/*
 * Research-only public-watch-to-native-price readiness receipt.
 * No historical watcher JSONL exists for the 2025-02-03 source period:
 * watchEvents and cadenceRows are INTENTIONALLY empty.
 *
 * Source price may be fetched using the existing venue PUBLIC candle probe.
 * This step never fabricates a 2025 watch event, 0% scanner recall or fills.
 */
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {reconcileOriginalPublicWatchV1}
 from "../src/public-watch-native-minute-reconcile-v1.js";
const input=resolve(process.argv[2] ??
 "market-prediction-lab/docs/native-utc-day-opportunity-v1.json");
const output=resolve(process.argv[3] ??
 "market-prediction-lab/docs/public-watch-native-minute-receipt-v1.json");
const nativeUtcDayReport=JSON.parse(readFileSync(input,"utf8"));
const audit=reconcileOriginalPublicWatchV1({
 nativeUtcDayReport,watchEvents:[],cadenceRows:[],
});
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(audit,null,2)+"\n",{
 encoding:"utf8",mode:0o600,
});
process.stdout.write(JSON.stringify({
 status:audit.status,
 observedNativeCrossingCountByMarket:Object.fromEntries(
  Object.entries(audit.markets).map(([m,v])=>[m,v.observedNativeCrossingCount])),
 crossCheckedSourceWatchEvents:audit.originalWatchEventRowsSupplied,
 historicalMarketWideRecall:audit.historicalMarketWideRecall,
 profitabilityProven:audit.profitabilityProven,
 executionAuthority:audit.executionAuthority,
})+"\n");
