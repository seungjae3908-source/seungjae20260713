import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,mkdir} from 'node:fs/promises';
import {patchV3CryptoScannerSource} from '../src/public-v3-crypto-source-patch.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const api=join(root,'api-server');
const require=createRequire(join(api,'package.json'));
const esbuild=require('esbuild');
if(process.argv.slice(2).some(a=>a!=='--external-packages'))
  throw Error('PUBLIC_V3_BUILD_UNKNOWN_OPTION');
const out=join(api,'.signal-intelligence/public-cycle.mjs');
await mkdir(dirname(out),{recursive:true});
let matches=0;
await esbuild.build({
  entryPoints:[join(root,'signal-intelligence-v3/scripts/run-public-scanner-cycle.ts')],
  bundle:true,platform:'node',format:'esm',target:'node20',
  packages:process.argv.includes('--external-packages')?'external':'bundle',
  outfile:out,
  banner:{js:'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'},
  plugins:[{name:'v3-public-crypto-cursor-only',setup(build){
    build.onLoad({filter:/crypto-signal-scanner\.service\.ts$/},async({path})=>{
      matches+=1;
      return {contents:patchV3CryptoScannerSource(await readFile(path,'utf8')),
        loader:'ts',resolveDir:dirname(path)};
    });
  }}],
});
if(matches!==1)throw Error('PUBLIC_V3_CRYPTO_SCANNER_PATCH_COUNT_INVALID');
process.stdout.write('PUBLIC_V3_STABLE_CRYPTO_BUNDLE_BUILT\n');
