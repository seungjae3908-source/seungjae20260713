#!/usr/bin/env node
/** Explicit operator read-only preflight. Run as the actual V3 service
 * user in an separately owner-approved Staging/Production QA. Never
 * changes service config, filesystem permissions, DB or Telegram sends.
 */
import {readV3StageOneWatch} from '../src/public-watch-v3-readonly.mjs';
const proof=await readV3StageOneWatch({enabled:true,
  expectedResearchSha:process.env.SIGNAL_INTELLIGENCE_V3_WATCH_RESEARCH_SHA,
});
const ready=['VALIDATED','PARTIAL_SOURCE'].includes(proof.status);
process.stdout.write(JSON.stringify({
  schemaVersion:'signal-v3-watch-readonly-preflight-v1',
  watchReadStatus:proof.status,
  sourceReadProven:ready,priorityReviewCandidates:ready?proof.report.priorityReviewCandidates:0,
  entireHistoricMarketCoverageProven:false,
  autoTradingAuthority:'NONE',
  productionTelegramDeliveryVerified:false,
  botApiSends:0,dbWrites:0,
})+'\n');
if(!ready)process.exitCode=1;
