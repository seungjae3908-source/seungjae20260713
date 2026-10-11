#!/usr/bin/env node
/**
 * Date-aligned, safe offline analysis of original Vultr public-watch exports
 * and exchange-native historical 1m crossing receipts.
 *
 * Operator can later pass:
 *  node report-matching-public-watch-v1.mjs NATIVE_DAY.json DIAGNOSTIC.json \
 *      ABSOLUTE_READONLY_EXPORTED_ROOT ORIGINAL_WATCH_RELEASE_SHA
 *
 * No root or release SHA is supplied in CI; no Vultr connection is made.
 * The original watch JSONL is never uploaded to GitHub or stored in output.
 */
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {
  examineOriginalPublicWatchJsonlV1,
  readOriginalPublicWatchExportV1,
} from "../src/public-watch-jsonl-original-intake-v1.js";
import {reconcileOriginalPublicWatchV1}
  from "../src/public-watch-native-minute-reconcile-v1.js";

const nativePath=resolve(process.argv[2] ??
 "market-prediction-lab/docs/native-watch-matched-day-v1.json");
const output=resolve(process.argv[3] ??
 "market-prediction-lab/docs/native-public-watch-matching-readiness-v1.json");
const root=process.argv[4]??null;
const originalRelease=process.argv[5]??null;
if(Boolean(root)!==Boolean(originalRelease))
  throw new Error("EXPORT_ROOT_AND_RESEARCH_SHA_MUST_BOTH_BE_EXPLICIT");
const native=JSON.parse(readFileSync(nativePath,"utf8"));
if(native.schemaVersion!=="native-utc-day-historical-public-1m-audit-v1"
   ||native.executionAuthority!=="NONE"||native.profitabilityProven!==false
   ||native.fullMarketOpportunityDenominatorVerified!==false
   ||native.trueMarketWideRecall!==null
   ||native.sampledDay?.dayUtc!=="2026-10-09")
  throw new TypeError("NATIVE_PUBLIC_SOURCE_DATE_OR_SAFETY_INVALID");
const dayUtc=native.sampledDay.dayUtc;
const intake=root
  ? await readOriginalPublicWatchExportV1({
      rootDir:root,dayUtc,expectedResearchSha:originalRelease,
    })
  : examineOriginalPublicWatchJsonlV1({dayUtc});
const matching=intake.receipt.status==="VALIDATED_POSITIVE_LOG_COHORT_ONLY"
  ? reconcileOriginalPublicWatchV1({
      nativeUtcDayReport:native,
      watchEvents:intake.originalEvents,cadenceRows:intake.cadenceRows,
    })
  : null;
const result=Object.freeze({
  schemaVersion:"native-day-original-public-watch-corroboration-readiness-v1",
  UTCDate:dayUtc,
  status:intake.receipt.status==="VALIDATED_POSITIVE_LOG_COHORT_ONLY"
    ?"ORIGINAL_WATCH_SELF_ATTESTED_POSITIVES_ONLY"
    :"BLOCKED_ORIGINAL_WATCH_EXPORT_NOT_ATTACHED",
  sourceDateMatchesWatcherExport:root!==null?true:null,
  originalPublicWatchIntake:intake.receipt,
  nativePriceMarkets:Object.fromEntries(Object.entries(native.markets).map(([market,row])=>[
    market,{
      status:row.status,observedMinuteCount:row.observedMinuteCount,
      nativePriceCrossingCount:row.observedDayCrossingCount,
      candleSha256:row.rawCandleSha256,
      originalWatcherAsOfVerified:false,
    },
  ])),
  sameDateSourceLimitedPositiveMatch:matching,
  // Source SHA only verifies bytes. Without independently authenticated
  // original server persistence/negative watchlists never claim true recall.
  nativeHistoricalSourceAcquiredAfterDay:true,
  originalServerFilesExternallyAuthenticated:false,
  historicalScannerOriginalAvailableAtVerified:false,
  historicalFullMarketUnobservedNegativeEvidenceVerified:false,
  trueMarketWideRecall:null,verifiedFalseNegativeCount:null,
  actualFillCount:null,netProfitPct:null,OOSPassCount:0,
  profitabilityProven:false,executionAuthority:"NONE",
  liveTrading:false,autoTrading:false,realOrders:false,
});
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(result,null,2)+"\n",{encoding:"utf8",mode:0o600});
process.stdout.write(JSON.stringify({
  dateUtc:result.UTCDate,status:result.status,
  sourcePriceMarkets:Object.fromEntries(Object.entries(result.nativePriceMarkets).map(([m,v])=>[
    m,{status:v.status,minuteBars:v.observedMinuteCount,
      nativeFirstCrossings:v.nativePriceCrossingCount},
  ])),
  originallyArchivedWatchEvents:result.originalPublicWatchIntake.distinctEventIds,
  trueMarketWideRecall:null,profitabilityProven:false,executionAuthority:"NONE",
})+"\n");
