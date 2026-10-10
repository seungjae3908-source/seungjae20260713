#!/usr/bin/env node
/**
 * Offline public-watch export intake. No Vultr connection, no login, keys,
 * private provider calls or background action. CLI usage:
 *   node report-public-watch-jsonl-intake-v1.mjs RECEIPT.json
 *   node report-public-watch-jsonl-intake-v1.mjs RECEIPT.json
 *     ABSOLUTE_EXPORTED_WATCH_ROOT YYYY-MM-DD ORIGINAL_WATCH_RELEASE_SHA
 *     [SAME_DAY_NATIVE_PRICE_REPORT.json]
 *
 * An explicit source directory (root/watch/events & root/watch/cadence) may
 * be supplied later. Raw watch events and cadence rows are NEVER saved
 * to the result or GitHub artifact. Only compact integrity/coverage receipt.
 */
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {
  examineOriginalPublicWatchJsonlV1,
  readOriginalPublicWatchExportV1,
} from "../src/public-watch-jsonl-original-intake-v1.js";
import {reconcileOriginalPublicWatchV1}
  from "../src/public-watch-native-minute-reconcile-v1.js";

const out=resolve(process.argv[2] ??
 "market-prediction-lab/docs/public-watch-jsonl-export-intake-v1.json");
const root=process.argv[3]??null;
if(root&&(!process.argv[4]||!process.argv[5]))
  throw new Error("EXPLICIT_EXPORT_DAY_AND_ORIGINAL_RELEASE_SHA_REQUIRED");
const result=root?await readOriginalPublicWatchExportV1({
 rootDir:root,dayUtc:process.argv[4],expectedResearchSha:process.argv[5],
}):examineOriginalPublicWatchJsonlV1({dayUtc:"2026-10-10"});
let nativeReconciliation=null;
if(process.argv[6]){
  if(result.receipt.status!=="VALIDATED_POSITIVE_LOG_COHORT_ONLY")
    throw new Error("ORIGINAL_WATCH_EXPORT_NOT_VERIFIED_FOR_NATIVE_COMPARISON");
  const native=JSON.parse(readFileSync(resolve(process.argv[6]),"utf8"));
  nativeReconciliation=reconcileOriginalPublicWatchV1({
    nativeUtcDayReport:native,
    watchEvents:result.originalEvents,
    cadenceRows:result.cadenceRows,
  });
}
const output=Object.freeze({
 ...result.receipt,
 nativeReconciliation,
 originalSourceEventsIncluded:false,
 originalCadenceRowsIncluded:false,
});
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,JSON.stringify(output,null,2)+"\n",{
 encoding:"utf8",mode:0o600,
});
process.stdout.write(JSON.stringify({
 status:output.status,reason:output.reason,dayUtc:output.dayUtc,
 originalEventRows:output.originalEventRows,
 distinctCadenceCycles:output.distinctCadenceCycles,
 marketWideRecall:output.trueMarketWideRecall,
 nativeStatus:output.nativeReconciliation?.status??null,
 profitabilityProven:false,executionAuthority:"NONE",
})+"\n");
