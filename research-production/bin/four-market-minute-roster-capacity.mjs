#!/usr/bin/env node
// Public current crypto roster diagnostic only. Not a timer or data publisher.
// Default is strictly OFF; explicit public GET probe requires owner review.
import { probePublicCurrentCryptoRosters } from
  '../src/four-market-minute-roster-capacity-v1.mjs';

const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
const fail=x=>{throw new Error(x);};
async function main(){
  const args=process.argv.slice(2);
  if(args.length===0||args.length===1&&args[0]==='--dry-run')
    return emit({status:'DISABLED',publicProviderCalls:0,
      dataStored:false,executionAuthority:'NONE'});
  if(args.length!==1||args[0]!=='--public-probe'
    ||process.env.RESEARCH_MINUTE_PUBLIC_ROSTER_PROBE_ENABLED!=='true')
    fail('MINUTE_ROSTER_OWNER_PROBE_APPROVAL_REQUIRED');
  const r=await probePublicCurrentCryptoRosters({enabled:true});
  // Do not disclose provider raw payloads, raw exchange warnings, host paths,
  // credentials, or fabricate a historic PIT roster from a current snapshot.
  emit({
    status:r.capacity.modeledCapacitySufficient
      ?'PUBLIC_ROSTER_REVIEW_REQUIRED':'HOLD_CAPACITY',
    publicProviderCalls:r.publicProviderCalls,
    upbit:{market:r.upbit.market,symbolCount:r.upbit.symbols.length,
      warningCount:r.upbit.restrictedSymbols.length,digest:r.upbit.digest},
    bitget:{market:r.bitget.market,symbolCount:r.bitget.symbols.length,
      warningCount:r.bitget.restrictedSymbols.length,digest:r.bitget.digest},
    capacity:r.capacity,
    dataStored:false,automaticallyEnabled:false,
    historicalPITProven:false,executionAuthority:'NONE',
  });
  if(!r.capacity.modeledCapacitySufficient) process.exitCode=2;
}
main().catch(e=>{
  const msg=/^MINUTE_[A-Z0-9_]{1,80}$/u.test(e?.message??'')
    ?e.message:'MINUTE_ROSTER_PUBLIC_PROBE_FAILED';
  emit({status:'BLOCKED',reason:msg,publicProviderCalls:0,
    dataStored:false,executionAuthority:'NONE'});
  process.exitCode=2;
});
