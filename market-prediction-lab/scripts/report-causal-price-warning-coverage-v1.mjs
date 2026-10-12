#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {evaluateCausalPriceWarningCoverageV1} from "../src/causal-price-warning-coverage-v1.js";
const summaryPath=resolve(process.argv[2]??
 "market-prediction-lab/docs/native-selected-historical-day-v1.json");
const rawPath=resolve(process.argv[3]??
 "market-prediction-lab/docs/native-selected-historical-day-raw-v1.json");
const output=resolve(process.argv[4]??
 "market-prediction-lab/docs/causal-price-warning-cohort-v1.json");
const result=evaluateCausalPriceWarningCoverageV1({
 selectedSummary:JSON.parse(readFileSync(summaryPath,"utf8")),
 selectedRaw:JSON.parse(readFileSync(rawPath,"utf8")),
 thresholds:[1,2,3,4],assumedSourceToSignalDelayMs:2_000,
});
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(result,null,2)+"\n",{encoding:"utf8",mode:0o600});
process.stdout.write(JSON.stringify({
 dateUtc:result.dateUtc,selectedSymbolDays:result.selectedSymbolDays,
 results:result.results,
 trueMarketWideRecall:result.realHistoricalScannerRecall,
 profitabilityProven:result.profitabilityProven,
 executionAuthority:result.executionAuthority,
})+"\n");
