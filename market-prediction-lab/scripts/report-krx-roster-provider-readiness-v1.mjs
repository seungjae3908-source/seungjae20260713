#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {collectKrxDatedRosterV1} from "../src/krx-dated-roster-public-read-v1.js";
// No KEY provided, no env read, no network request. Market-data approval absent.
const receipt=await collectKrxDatedRosterV1({dateYmd:"20250203"});
const dst=resolve(process.argv[2]??
 "market-prediction-lab/docs/krx-dated-roster-readiness-v1.json");
mkdirSync(dirname(dst),{recursive:true});
writeFileSync(dst,JSON.stringify(receipt,null,2)+"\n",{encoding:"utf8",mode:0o600});
process.stdout.write(JSON.stringify({
  status:receipt.status,reason:receipt.reason,
  historicListedCount:receipt.dateScopedSymbolCount,
  delistedHistoryVerified:false,trueMarketWideRecall:null,
  profitabilityProven:false,executionAuthority:"NONE",
})+"\n");
