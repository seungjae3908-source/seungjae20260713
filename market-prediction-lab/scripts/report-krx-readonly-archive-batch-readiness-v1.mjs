#!/usr/bin/env node
/**
 * Read-only research-source readiness check. No KRX market-data AUTH_KEY is
 * passed, no environment credentials are read and NO HTTP requests are made.
 */
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {collectKrxDatedRosterBatchV1}
  from "../src/krx-readonly-archive-batch-v1.js";

const receipt=await collectKrxDatedRosterBatchV1({
 requestedTradingDates:["20250203","20250204","20250205"],
 authKey:null,
});
const output=resolve(process.argv[2] ??
 "market-prediction-lab/docs/krx-readonly-archive-batch-readiness-v1.json");
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(receipt,null,2)+"\n",{
 encoding:"utf8",mode:0o600,
});
process.stdout.write(JSON.stringify({
 status:receipt.status,
 marketDataRequestsPerformed:receipt.requestsPerformed,
 observedKrxDays:receipt.observedDateCount,
 missingDateCount:receipt.missingDateCount,
 confirmedDelistingCount:receipt.historicalIdentityTimeline.confirmedDelistingCount,
 trueMarketWideRecall:receipt.trueMarketWideRecall,
 profitabilityProven:receipt.profitabilityProven,
 executionAuthority:receipt.executionAuthority,
})+"\n");
