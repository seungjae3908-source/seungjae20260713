import {readFile} from 'node:fs/promises';
import {assertBlockedKrPublicResearchCoverage} from '../src/public-kr-source-truth-gate.mjs';
const file=process.argv[2];
if(typeof file!=='string'||file.length===0)throw Error('KR_PUBLIC_QA_FILE_REQUIRED');
const snapshot=JSON.parse(await readFile(file,'utf8'));
const evidence=assertBlockedKrPublicResearchCoverage(snapshot);
console.log(JSON.stringify(evidence,null,2));
