import fs from 'node:fs';
import { getAccountAssets, getCurrentPositions, getUnfilledOrders, getFills, requestReadOnly } from '../src/bitget-private-readonly.mjs';

const p = '.env.dev';
if (!fs.existsSync(p)) { console.error('❌ .env.dev not found'); process.exit(1); }
for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) process.env[m[1]] = m[2].trim();
}

// 환경변수 이름 매핑 (기존 키 이름이 다를 수 있음)
process.env.BITGET_PRIVATE_API_KEY = process.env.BITGET_PRIVATE_API_KEY || process.env.BITGET_API_KEY;
process.env.BITGET_PRIVATE_SECRET_KEY = process.env.BITGET_PRIVATE_SECRET_KEY || process.env.BITGET_API_SECRET || process.env.BITGET_SECRET_KEY;
process.env.BITGET_PRIVATE_PASSPHRASE = process.env.BITGET_PRIVATE_PASSPHRASE || process.env.BITGET_API_PASSPHRASE || process.env.BITGET_PASSPHRASE;

for (const k of ['BITGET_PRIVATE_API_KEY','BITGET_PRIVATE_SECRET_KEY','BITGET_PRIVATE_PASSPHRASE']) {
  if (!process.env[k]) { console.error(`❌ MISSING: ${k}`); process.exit(1); }
  console.log(`✅ ${k}: set (length=${process.env[k].length}, masked)`);
}

function mask(v) { if (v==null) return v; const s=String(v); return s.length<=2?'***':s[0]+'*'.repeat(Math.min(s.length-2,8))+s[s.length-1]; }

console.log('\n════════════ LIVE READ-ONLY ════════════');
const results = {};

console.log('\n[1] account/assets');
try { const r = await getAccountAssets(); const keys = r && typeof r==='object' ? Object.keys(r).slice(0,6) : []; console.log(`✅ OK | keys=${keys.join(',')}`); if(r?.accountEquity) console.log(`  equity=${mask(r.accountEquity)}`); results.assets={ok:true,keys}; }
catch(e){ console.log(`❌ ${e.code}: ${e.message}`); results.assets={ok:false,code:e.code}; }

console.log('\n[2] position/current-position');
try { const r = await getCurrentPositions({category:'USDT-FUTURES'}); const n = (r?.list||[]).length; console.log(`✅ OK | positions=${n}`); results.positions={ok:true,count:n}; }
catch(e){ console.log(`❌ ${e.code}: ${e.message}`); results.positions={ok:false,code:e.code}; }

console.log('\n[3] trade/unfilled-orders');
try { const r = await getUnfilledOrders({category:'USDT-FUTURES',limit:10}); const n = (r?.list||[]).length; console.log(`✅ OK | unfilled=${n}`); results.orders={ok:true,count:n}; }
catch(e){ console.log(`❌ ${e.code}: ${e.message}`); results.orders={ok:false,code:e.code}; }

console.log('\n[4] trade/fills');
try { const r = await getFills({category:'USDT-FUTURES',limit:10}); const n = (r?.list||[]).length; console.log(`✅ OK | fills=${n}`); results.fills={ok:true,count:n}; }
catch(e){ console.log(`❌ ${e.code}: ${e.message}`); results.fills={ok:false,code:e.code}; }

console.log('\n[5] write block');
let blocked=0;
for (const [m,pa] of [['POST','/api/v3/trade/place-order'],['POST','/api/v3/trade/cancel-order'],['POST','/api/v3/account/withdraw'],['POST','/api/v3/account/transfer']]) {
  try { await requestReadOnly({method:m,requestPath:pa}); console.log(`❌ CRITICAL: ${m} ${pa} 통과!`); }
  catch(e){ if(['ENDPOINT_NOT_ALLOWED','FORBIDDEN_PATTERN'].includes(e.code)){blocked++;console.log(`✅ ${m} ${pa} → ${e.code}`);} }
}
results.blocked={ok:blocked===4,count:blocked};

console.log('\n════════════ SUMMARY ════════════');
for (const [k,v] of Object.entries(results)) console.log(`${k.padEnd(12)} ${v.ok?'✅ OK':'❌ '+(v.code||'')}`);
fs.writeFileSync('/tmp/block17a-result.json', JSON.stringify({ts:Date.now(),results},null,2));
process.exit(Object.values(results).every(r=>r.ok)?0:1);
