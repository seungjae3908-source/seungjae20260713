#!/usr/bin/env node
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {auditKrxDatedRosterTimelineV1} from "../src/krx-dated-roster-timeline-v1.js";
// Intentionally no key/network or unverified backfill. Official KRX daily
// market-data entitlement and genuine date receipts are not connected here.
const r=auditKrxDatedRosterTimelineV1({
 requestedTradingDates:["20250203","20250204","20250205"],
 datedReceipts:[],
});
const output=resolve(process.argv[2]??
 "market-prediction-lab/docs/krx-dated-roster-timeline-readiness-v1.json");
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(r,null,2)+"\n",{encoding:"utf8",mode:0o600});
process.stdout.write(JSON.stringify({
 status:r.status,observedDateCount:r.observedDateCount,
 missingRequestedDates:r.missingRequestedDates,
 confirmedDelistingCount:r.confirmedDelistingCount,
 trueMarketWideRecall:r.trueMarketWideRecall,
 profitabilityProven:false,executionAuthority:"NONE",
})+"\n");
