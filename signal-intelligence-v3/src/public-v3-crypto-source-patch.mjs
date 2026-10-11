/** Pure, exact-marker V3-only bundler transform. NEVER edit the shared
 * scanner or the authoritative Paper runtime package.
 */
const CURSOR='      const cursor = Math.max(0, Math.min(universe.rows.length, Math.floor(request.cursor) || 0));';
const PAGE='      const batch = universe.rows.slice(cursor, cursor + batchSize);';
const REPLACEMENT=`      // Public V3 pagination is stable, without changing regular member/Paper.
      const publicV3Rows = request.memberId === 'signal-intelligence-v3-public-only'
        ? stablePublicV3CryptoRows(universe.rows) : universe.rows;
      const cursor = Math.max(0, Math.min(publicV3Rows.length, Math.floor(request.cursor) || 0));
      const batch = publicV3Rows.slice(cursor, cursor + batchSize);`;
export function patchV3CryptoScannerSource(source){
  const original=CURSOR+'\n'+PAGE;
  if(typeof source!=='string'||source.split(original).length!==2
    ||source.includes('stablePublicV3CryptoRows')
    ||!source.includes('export function createCryptoSignalScannerService('))
    throw new Error('PUBLIC_V3_CRYPTO_SCANNER_BUILD_CONTRACT_INVALID');
  const imp="import {stablePublicV3CryptoRows} from '../../../signal-intelligence-v3/src/public-v3-crypto-ordered-page.mjs';\n";
  return imp+source.replace(original,REPLACEMENT);
}
