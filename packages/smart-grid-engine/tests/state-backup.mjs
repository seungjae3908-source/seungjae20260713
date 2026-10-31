import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP = '/tmp/paper-test-backup';
if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}: PASS (${detail})`); }
  else { fail++; console.log(`❌ ${name}: FAIL (${detail})`); }
}

// T1: Backup + corrupt + restore
const statePath = path.join(TMP, 'state.json');
const backupPath = path.join(TMP, 'state.json.backup');
const original = { meta: { symbol: 'BTCUSDT' }, lastCandleTs: 12345, processedFundings: [1000, 2000], totalFunding: 0.5, realizedPnl: 10 };
fs.writeFileSync(statePath, JSON.stringify(original, null, 2));
const h0 = hash(statePath);
fs.copyFileSync(statePath, backupPath);
const hb = hash(backupPath);
check('T1-1 백업 무결성', h0 === hb, `hash=${h0.slice(0,12)}`);

fs.writeFileSync(statePath, '{corrupted');
let corruptDetected = false;
try { JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { corruptDetected = true; }
check('T1-2 손상 감지', corruptDetected, 'JSON.parse throw');

fs.copyFileSync(backupPath, statePath);
const restored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const contentIntact = JSON.stringify(restored) === JSON.stringify(original);
check('T1-3 백업 복원 무결성', hash(statePath) === h0 && contentIntact, `restored.totalFunding=${restored.totalFunding}`);

// T2: Gap 증명 - 현재 orchestrator loadState 동작 재현
// (run-paper-forward-abc.mjs의 loadState 로직을 그대로 복사)
console.log('\n--- [T2] orchestrator loadState 동작 재현 ---');
function simulateCurrentLoadState(dir) {
  const f = path.join(dir, 'state.json');
  if (!fs.existsSync(f)) return { action: 'NEW_INIT', reason: 'NO_FILE' };
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!s.meta || typeof s.lastCandleTs !== 'number') throw new Error('SCHEMA_INVALID');
    return { action: 'LOADED', state: s };
  } catch (e) {
    try { fs.renameSync(f, `${f}.corrupt.${Date.now()}`); } catch {}
    return { action: 'RENAMED_AND_NEW_INIT', reason: e.message };
  }
}

const gapDir = path.join(TMP, 'gap-test');
fs.mkdirSync(gapDir);
fs.writeFileSync(path.join(gapDir, 'state.json'), '{corrupted');

const result = simulateCurrentLoadState(gapDir);
const gapConfirmed = result.action === 'RENAMED_AND_NEW_INIT';
console.log(`현재 동작: ${result.action} (${result.reason})`);
console.log(`→ 지시서 요구: "자동 초기화 금지, fail-closed"`);
if (gapConfirmed) {
  console.log('🚨 GAP 확인: 현재 orchestrator는 손상 시 자동 재초기화 (요구사항 위반)');
  fail++;  // GAP을 FAIL로 카운트 (수정 필요 증명)
} else {
  console.log('✅ fail-closed 동작 확인');
  pass++;
}

// T3: 제안 수정 로직 (fail-closed) - 검증만
// [FIX] T2에서 rename되었으므로 gapDir 재초기화
if (fs.existsSync(gapDir)) fs.rmSync(gapDir, { recursive: true });
fs.mkdirSync(gapDir);
fs.writeFileSync(path.join(gapDir, 'state.json'), '{corrupted');
console.log('\n--- [T3] 제안 fail-closed 로직 검증 (적용 안 함) ---');
function proposedFailClosedLoadState(dir) {
  const f = path.join(dir, 'state.json');
  const backup = path.join(dir, 'state.json.backup');
  if (!fs.existsSync(f)) return { action: 'NEW_INIT_ALLOWED', reason: 'NO_FILE_AT_ALL' };
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!s.meta || typeof s.lastCandleTs !== 'number') throw new Error('SCHEMA_INVALID');
    return { action: 'LOADED', state: s };
  } catch (e) {
    // 손상 감지 → 백업 시도
    if (fs.existsSync(backup)) {
      try {
        const b = JSON.parse(fs.readFileSync(backup, 'utf8'));
        return { action: 'RESTORED_FROM_BACKUP', state: b };
      } catch {}
    }
    return { action: 'FAIL_CLOSED', reason: 'CORRUPT_NO_BACKUP' };  // 신규 진입 차단
  }
}
const fcResult = proposedFailClosedLoadState(gapDir);
const fcOk = fcResult.action === 'FAIL_CLOSED';
check('T3 제안 로직이 fail-closed 구현 가능함을 검증', fcOk, `action=${fcResult.action}`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n결과: PASS=${pass}, FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
