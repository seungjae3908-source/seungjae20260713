import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ORCH = path.resolve('run-paper-forward-abc.mjs');
const TMP_BASE = '/tmp/orch-verify';
const TMP = path.join(TMP_BASE, 'acc');
let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; console.log(`✅ ${n}: PASS (${d||''})`); } else { fail++; console.log(`❌ ${n}: FAIL (${d||''})`); } }
function cleanup() { if (fs.existsSync(TMP_BASE)) fs.rmSync(TMP_BASE, { recursive: true }); fs.mkdirSync(TMP, { recursive: true }); }
function writeState(d) { fs.writeFileSync(path.join(TMP, 'state.json'), typeof d === 'string' ? d : JSON.stringify(d)); }
function writeBackup(d) { fs.writeFileSync(path.join(TMP, 'state.json.backup'), typeof d === 'string' ? d : JSON.stringify(d)); }
function readState() { return JSON.parse(fs.readFileSync(path.join(TMP, 'state.json'), 'utf8')); }
function readBackup() { return JSON.parse(fs.readFileSync(path.join(TMP, 'state.json.backup'), 'utf8')); }

// [1] Import safety
console.log('\n=== [1] Import safety ===');
const t0 = Date.now();
const mod = await import(pathToFileURL(ORCH).href);
const importMs = Date.now() - t0;
check('import < 2000ms', importMs < 2000, `${importMs}ms`);
check('loadState exported', typeof mod.loadState === 'function', `typeof=${typeof mod.loadState}`);
check('saveStateAtomic exported', typeof mod.saveStateAtomic === 'function', '');

// [2] Scenario A: Normal
console.log('\n=== [2] Scenario A: 정상 로드 ===');
cleanup(); writeState({ meta: { s: 'BTCUSDT' }, lastCandleTs: 1000, data: 'NORMAL' });
let rA, eA = null;
try { rA = mod.loadState({ dir: TMP }, 'A'); } catch (e) { eA = e; }
check('A 정상 로드', rA && rA.lastCandleTs === 1000 && rA.data === 'NORMAL' && !eA, `lastTs=${rA?.lastCandleTs}`);

// [3] Scenario B: Corrupt + valid backup
console.log('\n=== [3] Scenario B: 손상+backup 복구 ===');
cleanup(); writeState('{corrupted'); writeBackup({ meta: { s: 'BTCUSDT' }, lastCandleTs: 2000, data: 'FROM_BACKUP' });
let rB, eB = null;
try { rB = mod.loadState({ dir: TMP }, 'B'); } catch (e) { eB = e; }
check('B backup 복구', rB && rB.lastCandleTs === 2000 && rB.data === 'FROM_BACKUP' && !eB, `lastTs=${rB?.lastCandleTs}`);
check('B 손상 원본 보존', fs.readdirSync(TMP).some(f => f.includes('.corrupt.')), '');

// [4] Scenario C: Corrupt + no backup
console.log('\n=== [4] Scenario C: 손상+backup없음 → FAIL_CLOSED ===');
cleanup(); writeState('{corrupted');
let rC, eC = null;
try { rC = mod.loadState({ dir: TMP }, 'C'); } catch (e) { eC = e; }
check('C FAIL_CLOSED', !rC && eC && eC.message.includes('FAIL_CLOSED'), `msg=${eC?.message?.slice(0,60)}`);
check('C 자동 재초기화 금지', !fs.existsSync(path.join(TMP, 'state.json')), 'state.json 없음 (rename됨)');

// [5] Scenario D: Both corrupt
console.log('\n=== [5] Scenario D: 둘다 손상 → FAIL_CLOSED ===');
cleanup(); writeState('{corrupt1'); writeBackup('{corrupt2');
let rD, eD = null;
try { rD = mod.loadState({ dir: TMP }, 'D'); } catch (e) { eD = e; }
check('D FAIL_CLOSED', !rD && eD && eD.message.includes('FAIL_CLOSED'), `msg=${eD?.message?.slice(0,80)}`);

// [6] Backup auto-generation
console.log('\n=== [6] Backup auto-generation ===');
cleanup();
const acc = { dir: TMP };
mod.saveStateAtomic(acc, { meta: { s: 'BTCUSDT' }, lastCandleTs: 3000, data: 'FIRST' });
check('1차 저장: state 생성', fs.existsSync(path.join(TMP, 'state.json')), '');
check('1차 저장: backup 없음 (기대)', !fs.existsSync(path.join(TMP, 'state.json.backup')), '');
mod.saveStateAtomic(acc, { meta: { s: 'BTCUSDT' }, lastCandleTs: 4000, data: 'SECOND' });
check('2차 저장: backup 생성', fs.existsSync(path.join(TMP, 'state.json.backup')), '');
check('2차: backup=FIRST', readBackup().data === 'FIRST', `data=${readBackup().data}`);
check('2차: state=SECOND', readState().data === 'SECOND', `data=${readState().data}`);
writeState('{corrupted');
mod.saveStateAtomic(acc, { meta: { s: 'BTCUSDT' }, lastCandleTs: 5000, data: 'THIRD' });
check('3차: 손상 state 저장 시 backup 보존', readBackup().data === 'FIRST', `backup=${readBackup().data}`);
check('3차: state=THIRD', readState().data === 'THIRD', `data=${readState().data}`);

fs.rmSync(TMP_BASE, { recursive: true });
console.log(`\n════════ 종합 ════════`);
console.log(`PASS=${pass}, FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
