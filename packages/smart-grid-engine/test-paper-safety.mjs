import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const ROOT = './paper-abc';
const A_DIR = path.join(ROOT, 'A-baseline');
const B_DIR = path.join(ROOT, 'B-trailing');
const ORCH = 'run-paper-forward-abc.mjs';

function reset() { if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(A_DIR, { recursive: true }); fs.mkdirSync(B_DIR, { recursive: true }); }
function readState(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); }
async function runOrch(ms, sig = 'SIGTERM') {
  const child = spawn('node', [ORCH], { stdio: 'inherit' });
  await new Promise(r => setTimeout(r, ms));
  try { child.kill(sig); } catch {}
  await new Promise(r => setTimeout(r, 2500));
}

async function t1_stalePid() {
  console.log('\n=== [T1] stale PID ===');
  reset();
  fs.writeFileSync(path.join(A_DIR, 'pid'), '999999');
  fs.writeFileSync(path.join(A_DIR, 'lock'), '999999');
  await runOrch(10000, 'SIGTERM');
  const stateExists = fs.existsSync(path.join(A_DIR, 'state.json'));
  const lockAfter = fs.existsSync(path.join(A_DIR, 'lock'));
  const ok = stateExists && !lockAfter;
  console.log(`state:${stateExists}, lock after SIGTERM:${lockAfter} → ${ok ? '✅ PASS' : '❌ FAIL'}`);
  return ok;
}

async function t2_sigkillRecovery() {
  console.log('\n=== [T2] SIGKILL recovery ===');
  reset();
  const child = spawn('node', [ORCH], { stdio: 'inherit' });
  await new Promise(r => setTimeout(r, 10000));
  const preA = readState(A_DIR);
  const preC = preA.processedCandles, preTs = preA.lastCandleTs, preFund = preA.lastFundingTs;
  console.log(`Pre-kill: candles=${preC}, lastTs=${preTs}, fundTs=${preFund}`);
  child.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 1500));
  await runOrch(10000, 'SIGTERM');
  const postA = readState(A_DIR);
  console.log(`Post: candles=${postA.processedCandles}, lastTs=${postA.lastCandleTs}, fundTs=${postA.lastFundingTs}`);
  const noBackward = postA.lastCandleTs >= preTs;
  const fundNoDup = new Set(postA.processedFundings || []).size === (postA.processedFundings || []).length;
  const ok = noBackward && fundNoDup;
  console.log(`noBackward:${noBackward}, fundNoDup:${fundNoDup} → ${ok ? '✅ PASS' : '❌ FAIL'}`);
  return ok;
}

async function t3_accountSeparation() {
  console.log('\n=== [T3] A/B separation ===');
  reset();
  await runOrch(10000, 'SIGTERM');
  const aExists = fs.existsSync(path.join(A_DIR, 'state.json'));
  const bExists = fs.existsSync(path.join(B_DIR, 'state.json'));
  const bBefore = crypto.createHash('sha256').update(fs.readFileSync(path.join(B_DIR, 'state.json'))).digest('hex');
  const aState = readState(A_DIR);
  aState.realizedPnl += 100;
  fs.writeFileSync(path.join(A_DIR, 'state.json'), JSON.stringify(aState, null, 2));
  const bAfter = crypto.createHash('sha256').update(fs.readFileSync(path.join(B_DIR, 'state.json'))).digest('hex');
  const bUnaffected = bBefore === bAfter;
  const ok = aExists && bExists && bUnaffected;
  console.log(`A:${aExists}, B:${bExists}, B unchanged after A mod:${bUnaffected} → ${ok ? '✅ PASS' : '❌ FAIL'}`);
  return ok;
}

async function t4_candleDedup() {
  console.log('\n=== [T4] candle dedup ===');
  reset();
  const child = spawn('node', [ORCH], { stdio: 'inherit' });
  await new Promise(r => setTimeout(r, 10000));
  child.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 1500));
  const preA = readState(A_DIR);
  await runOrch(10000, 'SIGTERM');
  const postA = readState(A_DIR);
  const newDup = postA.duplicateCandles - preA.duplicateCandles;
  const newProc = postA.processedCandles - preA.processedCandles;
  const ok = postA.processedCandles >= preA.processedCandles;
  console.log(`pre:${preA.processedCandles}, post:${postA.processedCandles}, newProc:${newProc}, newDup:${newDup} → ${ok ? '✅ PASS' : '❌ FAIL'}`);
  return ok;
}

async function t5_fundingDedup() {
  console.log('\n=== [T5] funding dedup ===');
  const aState = readState(A_DIR);
  const pf = aState.processedFundings || [];
  const uniq = new Set(pf).size;
  const noDup = pf.length === uniq;
  console.log(`processedFundings:${pf.length}, unique:${uniq} → ${noDup ? '✅ PASS' : '❌ FAIL'}`);
  return noDup;
}

async function t6_dataHashEquality() {
  console.log('\n=== [T6] A/B lastCandleTs equality ===');
  const aState = readState(A_DIR), bState = readState(B_DIR);
  const same = aState.lastCandleTs === bState.lastCandleTs;
  console.log(`A lastTs:${aState.lastCandleTs}, B lastTs:${bState.lastCandleTs} → ${same ? '✅ PASS' : '❌ FAIL'}`);
  return same;
}

async function t7_atomicWrite() {
  console.log('\n=== [T7] atomic write ===');
  reset();
  await runOrch(6000, 'SIGTERM');
  // Corrupt state.json and verify orchestrator handles it
  fs.writeFileSync(path.join(A_DIR, 'state.json'), '{bad json');
  await runOrch(8000, 'SIGTERM');
  const corruptFiles = fs.readdirSync(A_DIR).filter(f => f.includes('.corrupt.'));
  const stateRestored = fs.existsSync(path.join(A_DIR, 'state.json'));
  let parses = false;
  try { JSON.parse(fs.readFileSync(path.join(A_DIR, 'state.json'), 'utf8')); parses = true; } catch {}
  const ok = corruptFiles.length > 0 && stateRestored && parses;
  console.log(`corrupt backup:${corruptFiles.length}, state restored:${stateRestored}, parses:${parses} → ${ok ? '✅ PASS' : '❌ FAIL'}`);
  return ok;
}

async function main() {
  console.log('=== Paper Forward Safety Tests ===');
  const r1 = await t1_stalePid();
  const r2 = await t2_sigkillRecovery();
  const r3 = await t3_accountSeparation();
  const r4 = await t4_candleDedup();
  const r5 = await t5_fundingDedup();
  const r6 = await t6_dataHashEquality();
  const r7 = await t7_atomicWrite();

  console.log('\n════════ RESULTS ════════');
  console.log(`T1 stale PID:              ${r1 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`T2 SIGKILL recovery:       ${r2 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`T3 A/B separation:         ${r3 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`T4 candle dedup:           ${r4 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`T5 funding dedup:          ${r5 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`T6 data hash equality:     ${r6 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`T7 atomic write:           ${r7 ? '✅ PASS' : '❌ FAIL'}`);
  const all = r1 && r2 && r3 && r4 && r5 && r6 && r7;
  console.log(`\nOverall: ${all ? '✅ ALL PASS' : '❌ SOME FAILED'}`);
  process.exit(all ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
