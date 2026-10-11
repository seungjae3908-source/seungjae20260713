import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stablePublicV3CryptoRows} from '../src/public-v3-crypto-ordered-page.mjs';
import {patchV3CryptoScannerSource} from '../src/public-v3-crypto-source-patch.mjs';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const source=readFileSync(resolve(root,
  'api-server/src/services/crypto-signal-scanner.service.ts'),'utf8');
test('V3 stable index pagination never repeats rank-shuffled Upbit and Bitget symbols',()=>{
  const symbols=['ALPHA','BETA','CHI','DELTA','EPSILON','ZETA'];
  for(const market of ['spot','futures']){
    const ranked=[...symbols].reverse().map((symbol,i)=>({symbol,tradingValue:i+10}));
    const reordered=[...symbols].map((symbol,i)=>({symbol,tradingValue:100-i}));
    const first=stablePublicV3CryptoRows(ranked).slice(0,5);
    const next=stablePublicV3CryptoRows(reordered).slice(5);
    assert.deepEqual([...first,...next].map(x=>x.symbol),symbols,market);
    assert.deepEqual(ranked.map(x=>x.symbol),[...symbols].reverse());
    assert.ok([...first,...next].every(x=>Number.isFinite(x.tradingValue)));
  }
});
test('V3 only rejects duplicate and malformed public ticker identities',()=>{
  for(const bad of [[],[{symbol:''}],[{symbol:' BTC'}],
    [{symbol:'BTC\nUSDT'}],[{symbol:'BTC'},{symbol:'BTC'}]])
    assert.throws(()=>stablePublicV3CryptoRows(bad),/PUBLIC_V3_CRYPTO_ROSTER/);
});
test('market-defined Bitget future code punctuation is sortable without silently dropping a symbol',()=>{
  const rows=[{symbol:'BTC/USDT'},{symbol:'BTC@USDT'},
    {symbol:'BTCUSDT_UMCBL'},{symbol:'1000000PEPEUSDT'},
    {symbol:'LONGALTCOININDEXUSDTINDEXFUTURES202612'}];
  const out=stablePublicV3CryptoRows(rows);
  assert.equal(out.length,rows.length);
  assert.equal(new Set(out.map(x=>x.symbol)).size,rows.length);
});
test('only an exact upstream scanner source can be transformed; Paper source stays intact',()=>{
  const isolated=patchV3CryptoScannerSource(source);
  assert.ok(isolated.includes('publicV3Rows.slice(cursor, cursor + batchSize)'));
  assert.ok(isolated.includes("request.memberId === 'signal-intelligence-v3-public-only'"));
  assert.ok(!source.includes('stablePublicV3CryptoRows'));
  assert.ok(isolated.includes('normalizeV3UpbitCandles(rows, {'));
  assert.ok(!source.includes('normalizeV3UpbitCandles'));
  assert.ok(isolated.includes('const DEADLINE_MS = 16_000;'));
  assert.ok(isolated.includes('const ITEM_TIMEOUT_MS = 5_000;'));
  assert.ok(source.includes('const DEADLINE_MS = 12_000;'));
  assert.ok(source.includes('const ITEM_TIMEOUT_MS = 3_500;'));
  assert.ok(source.includes('time: finite(row.timestamp)'), 'member and Paper code is untouched');
  assert.throws(()=>patchV3CryptoScannerSource(isolated),/BUILD_CONTRACT_INVALID/);
  assert.throws(()=>patchV3CryptoScannerSource('broken'),/BUILD_CONTRACT_INVALID/);
});
