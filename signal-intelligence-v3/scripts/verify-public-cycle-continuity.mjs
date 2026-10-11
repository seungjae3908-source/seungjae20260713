import {readFile} from 'node:fs/promises';
import {verifyPublicTwoCycleContinuity} from '../src/public-cycle-continuity.mjs';
import path from 'node:path';
const [first,firstState,second,secondState]=process.argv.slice(2);
if([first,firstState,second,secondState].some(s=>!path.isAbsolute(s)))
  throw Error('PUBLIC_TWO_CYCLE_ABSOLUTE_INPUTS_ONLY');
const read=async filename=>JSON.parse(await readFile(filename,'utf8'));
const report=verifyPublicTwoCycleContinuity({
  firstSnapshot:await read(first),firstState:await read(firstState),
  secondSnapshot:await read(second),secondState:await read(secondState),
  head:process.env.SIGNAL_INTELLIGENCE_SERVICE_SHA,surface:'MEMBER_UI',
});
console.log(JSON.stringify(report,null,2));
