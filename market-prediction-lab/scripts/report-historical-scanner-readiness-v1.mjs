#!/usr/bin/env node
/**
 * Deterministic evidence-gap receipt on the actual native historical UTC day.
 * NO historical scanner ledger is injected: as-of detection remains UNKNOWN.
 */
import { readFileSync,writeFileSync,mkdirSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { buildHistoricalScannerFunnelReadinessV1 } from "../src/historical-scanner-evidence-funnel-v1.js";
const input=resolve(process.argv[2]??"market-prediction-lab/docs/native-utc-day-opportunity-v1.json");
const out=resolve(process.argv[3]??"market-prediction-lab/docs/historical-scanner-funnel-readiness-v1.json");
const report=buildHistoricalScannerFunnelReadinessV1({
  nativeUtcDayReport:JSON.parse(readFileSync(input,"utf8")),
  scannerLedgers:{},
});
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,JSON.stringify(report,null,2)+"\n",{encoding:"utf8",mode:0o600});
process.stdout.write(JSON.stringify({
  status:report.status,observedOpportunityCountInAvailableSamples:report.observedOpportunityCountInAvailableSamples,
  markets:Object.fromEntries(Object.entries(report.markets).map(([k,v])=>[k,{
    status:v.status,observedOpportunityCount:v.observedOpportunityCount,
    earlyDetectedCount:v.earlyDetectedCount,
    reasons:v.reasonCounts??(v.reason?{[v.reason]:1}:null),
  }])),
  profitabilityProven:false,executionAuthority:"NONE",
})+"\n");
