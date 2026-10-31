import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { initState as initA, applyFunding as fundA } from '../src/paper-forward-engine.mjs';
import { initStateB, applyFundingB } from '../src/paper-forward-trailing.mjs';

const TMP = '/tmp/paper-test-funding';
if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

function makeState(initFn, id) {
  const s = initFn({ symbol: 'BTCUSDT', startPrice: 70000, gridCount: 20, investmentUsdt: 300, leverage: 2, rangePct: 0.15, pricePlace: 1, volumePlace: 4, minTradeNum: 0.0001 });
  s.accountId = id;
  s.positions.push({ id: 1, type: 'BUY', price: 70000, qty: 0.001, status: 'OPEN', openedAt: 0, entryFee: 0 });
  return s;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}: PASS (${detail})`); }
  else { fail++; console.log(`❌ ${name}: FAIL (${detail})`); }
}

// T1: Direct idempotency (A)
const a1 = makeState(initA, 'A');
const before1 = a1.totalFunding;
const applied1 = fundA(a1, 1000000, 0.0001);
const applied2 = fundA(a1, 1000000, 0.0001);
const after2 = a1.totalFunding;
check('T1 동일 ts 2회 주입 (A)', applied1 > 0 && applied2 === 0 && after2 === before1 + applied1 && a1.processedFundings.includes(1000000), `applied1=${applied1.toFixed(6)}, applied2=${applied2}`);

// T2: Persistence (save → discard → reload → re-apply)
const statePath = path.join(TMP, 'A.json');
fs.writeFileSync(statePath, JSON.stringify(a1, null, 2));
const reloaded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const beforeReload = reloaded.totalFunding;
const applied3 = fundA(reloaded, 1000000, 0.0001);
check('T2 저장 후 재로드 시 재적용 방지', applied3 === 0 && reloaded.totalFunding === beforeReload && reloaded.processedFundings.includes(1000000), `applied3=${applied3}, fund=${reloaded.totalFunding.toFixed(6)}`);

// T3: A/B independence
const aS = makeState(initA, 'A');
const bS = makeState(initStateB, 'B');
fundA(aS, 2000, 0.0002);
fundA(aS, 2000, 0.0002);
fundA(aS, 3000, 0.0001);
fundA(bS, 2000, 0.0002);
fundA(bS, 2000, 0.0002);
const t3ok = aS.processedFundings.length === 2 && bS.processedFundings.length === 1 && aS.totalFunding > 0 && bS.totalFunding > 0 && aS.totalFunding !== bS.totalFunding;
check('T3 A/B 펀딩 독립성', t3ok, `A=${aS.processedFundings.length}/${aS.totalFunding.toFixed(6)}, B=${bS.processedFundings.length}/${bS.totalFunding.toFixed(6)}`);

// T4: SIGKILL simulation via child
const childScript = path.join(TMP, 'child.mjs');
fs.writeFileSync(childScript, `
import fs from 'node:fs';
import { initState, applyFunding } from '${process.cwd()}/src/paper-forward-engine.mjs';
const s = initState({ symbol: 'BTCUSDT', startPrice: 70000, gridCount: 20, investmentUsdt: 300, leverage: 2, rangePct: 0.15, pricePlace: 1, volumePlace: 4, minTradeNum: 0.0001 });
s.positions.push({ id: 1, type: 'BUY', price: 70000, qty: 0.001, status: 'OPEN', openedAt: 0, entryFee: 0 });
applyFunding(s, 5000, 0.0001);
fs.writeFileSync('${TMP}/sigkill.json', JSON.stringify(s, null, 2));
console.log('SAVED', s.totalFunding.toFixed(6));
setInterval(() => {}, 1000);
`);
const child = spawn('node', [childScript], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', d => { output += d.toString(); });
await new Promise(r => setTimeout(r, 2000));
child.kill('SIGKILL');
await new Promise(r => setTimeout(r, 500));
const killState = JSON.parse(fs.readFileSync(path.join(TMP, 'sigkill.json'), 'utf8'));
const preFund = killState.totalFunding;
const reApplied = fundA(killState, 5000, 0.0001);
check('T4 SIGKILL 후 펀딩 재적용 방지', reApplied === 0 && killState.totalFunding === preFund && killState.processedFundings.includes(5000), `pre=${preFund.toFixed(6)}, re-applied=${reApplied}`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n결과: PASS=${pass}, FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
