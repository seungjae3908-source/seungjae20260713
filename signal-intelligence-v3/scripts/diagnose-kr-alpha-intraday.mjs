// One publicly readable KR alphanumeric ETF minute canary. No production
// schedule, order, account or private exchange API. One bounded GET only.
import {createPublicKrAlphaOneSessionFeed} from '../src/public-kr-alpha-intraday.mjs';
const feed=createPublicKrAlphaOneSessionFeed();
let result;
try{
 const session=await feed.getOneSession('0193W0');
 result={
  verdict:'SINGLE_SESSION_1M_AND_5M_VALIDATED',
  oneMinuteCount:session.oneMinute.length,fiveMinuteCount:session.fiveMinute.length,
  closeMarkerVerified:session.sourceCloseMarkerPresent,
  sourceSessionContinuityVerified:session.sourceSessionContinuityVerified,
 };
}catch(error){
 result={verdict:'SOURCE_REQUIRES_REVIEW',
  sanitizedReason:error instanceof Error?error.message.split(':')[0]:'UNKNOWN',
 };
}
console.log(JSON.stringify({
 publicOnly:true,executionAuthority:'NONE',productionActivated:false,
 noOrderApis:true,fullEligibleRosterVerified:false,
 noRedistributionLicenseVerified:true,firstSessionProbe:result,
},null,2));
