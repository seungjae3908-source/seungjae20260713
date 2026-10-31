// block19-regression.test.mjs
// BLOCK 19 Step 5 — A/B 기준값 회귀 (파일 무결성 회귀, 경로 2)
//
// 원칙:
//   - fs.writeFile / appendFile 절대 금지 (fs.readFileSync 만 사용)
//   - backtest-engine 재실행 없음 (네트워크 위험 회피)
//   - 기준 파일 삭제/덮어쓰기 절대 금지
//   - 값이 어긋나면 assert 실패 → 기준값 갱신 금지
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/opt/smart-grid-dev/packages/smart-grid-engine';

// 반올림 허용 오차 (지시서: 명시 필수)
const TOL = {
  pnl: 1e-4,
  pf: 1e-4,
  mdd: 1e-4,
  rate: 1e-4,
};

function readJson(relPath) {
  const p = path.join(ROOT, relPath);
  assert.equal(fs.existsSync(p), true, `기준 파일 없음: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function approx(actual, expected, tol, label) {
  assert.ok(Number.isFinite(actual), `${label}: actual not finite (${actual})`);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: |${actual} - ${expected}| > ${tol}`,
  );
}

// ════════════════════════════════════════════════════
// A. A 기준값 회귀 (exp-20261030-btc-2x-20g-15pct)
//    명세서: +21.23 USDT / PF 2.62 / MDD 13.72% / 74 trades
// ════════════════════════════════════════════════════
test('R1: A 기준값 회귀 (exp-20261030-btc-2x-20g-15pct)', () => {
  const d = readJson('experiments/exp-20261030-btc-2x-20g-15pct/result.json');
  const r = d.result;
  assert.ok(r, 'result 필드 없음');

  approx(r.netPnl, 21.231912253920004, TOL.pnl, 'A.netPnl');
  approx(r.profitFactor, 2.6203683968086198, TOL.pf, 'A.profitFactor');
  approx(r.maxDD, 13.721674177902655, TOL.mdd, 'A.maxDD');
  assert.equal(r.completedTrades, 74, 'A.completedTrades');
  assert.equal(r.wins, 48, 'A.wins');
  assert.equal(r.liquidations, 0, 'A.liquidations');
});

// ════════════════════════════════════════════════════
// B. B 기준값 회귀 (comparison.json)
//    명세서: +32.52 USDT / PF 1.94 / MDD 11.18% / 135 trades
// ════════════════════════════════════════════════════
test('R2: B 기준값 회귀 (phase3-abc comparison)', () => {
  const d = readJson('experiments/phase3-abc-20261030-v2/comparison.json');
  const b = d.results?.B;
  assert.ok(b, 'results.B 없음');

  approx(b.netPnl, 32.52279655128001, TOL.pnl, 'B.netPnl');
  approx(b.profitFactor, 1.9429872741094478, TOL.pf, 'B.profitFactor');
  approx(b.maxDD, 11.180467037376687, TOL.mdd, 'B.maxDD');
  assert.equal(b.trades, 135, 'B.trades');
  assert.equal(b.wins, 85, 'B.wins');
  assert.equal(b.liquidations, 0, 'B.liquidations');
});

test('R3: comparison 의 A 도 일치 (이중 확인)', () => {
  const d = readJson('experiments/phase3-abc-20261030-v2/comparison.json');
  const a = d.results?.A;
  assert.ok(a, 'results.A 없음');
  approx(a.netPnl, 21.231912253920004, TOL.pnl, 'comparison.A.netPnl');
  approx(a.profitFactor, 2.6203683968086198, TOL.pf, 'comparison.A.profitFactor');
  approx(a.maxDD, 13.721674177902655, TOL.mdd, 'comparison.A.maxDD');
  assert.equal(a.trades, 74, 'comparison.A.trades');
});

// ════════════════════════════════════════════════════
// H. H Squeeze (H1) 기준값 회귀
//    명세서: +94.04 USDT / PF 3.26 / MDD 8.10% / 13 trades
// ════════════════════════════════════════════════════
test('R4: H Squeeze 회귀 (H1)', () => {
  const d = readJson('experiments/strategy-expansion-20261030/H1/result.json');
  approx(d.netPnl, 94.0391, TOL.pnl, 'H1.netPnl');
  approx(d.profitFactor, 3.26, TOL.pf, 'H1.profitFactor');
  approx(d.maxDD, 8.1, TOL.mdd, 'H1.maxDD');
  assert.equal(d.trades, 13, 'H1.trades');
});

// ════════════════════════════════════════════════════
// E. E1 / G1 회귀 (참고 지표)
// ════════════════════════════════════════════════════
test('R5: E1 회귀', () => {
  const d = readJson('experiments/strategy-expansion-20261030/E1/result.json');
  approx(d.netPnl, -12.0203, TOL.pnl, 'E1.netPnl');
  approx(d.profitFactor, 0.91, TOL.pf, 'E1.profitFactor');
  approx(d.maxDD, 21.14, TOL.mdd, 'E1.maxDD');
  assert.equal(d.trades, 33, 'E1.trades');
});

test('R6: G1 회귀', () => {
  const d = readJson('experiments/strategy-expansion-20261030/G1/result.json');
  approx(d.netPnl, 28.2696, TOL.pnl, 'G1.netPnl');
  approx(d.profitFactor, 1.31, TOL.pf, 'G1.profitFactor');
  approx(d.maxDD, 15.71, TOL.mdd, 'G1.maxDD');
  assert.equal(d.trades, 22, 'G1.trades');
});

// ════════════════════════════════════════════════════
// E55 — 명세서에는 있으나 파일 미확인 (존재 시에만)
// ════════════════════════════════════════════════════
test('R7: E55 회귀 (파일 존재 시에만)', (t) => {
  const candidates = [
    'experiments/strategy-expansion-20261030/E55/result.json',
    'experiments/strategy-expansion-20261030/E5/result.json',
  ];
  const found = candidates.find((p) => fs.existsSync(path.join(ROOT, p)));
  if (!found) {
    t.skip('E55 기준 파일 미존재 — skip (기준값 임의 생성 금지)');
    return;
  }
  const d = readJson(found);
  // 명세서: +65.88 USDT / PF 2.73 / MDD 8.02% / 11 trades
  approx(d.netPnl, 65.88, TOL.pnl, 'E55.netPnl');
  approx(d.profitFactor, 2.73, TOL.pf, 'E55.profitFactor');
  approx(d.maxDD, 8.02, TOL.mdd, 'E55.maxDD');
  assert.equal(d.trades, 11, 'E55.trades');
});

// ════════════════════════════════════════════════════
// K. 정적 보증 — 회귀 테스트가 기준 파일을 쓰지 않음
// ════════════════════════════════════════════════════
test('RK1: 정적 보증 — 이 테스트 파일이 파일 쓰기 API 를 쓰지 않는다', () => {
  // 상단 import fs 재사용 (require 는 ESM 에 없음)
  const self = '/opt/smart-grid-dev/packages/smart-grid-engine/tests/block19-regression.test.mjs';
  const src = fs.readFileSync(self, 'utf8');
  // 함수 호출 패턴으로 검사 (문자열/주석/자기 참조 회피)
  assert.equal(/fs\.writeFileSync\(/.test(src), false, 'writeFileSync 호출 금지');
  assert.equal(/fs\.writeFile\(/.test(src), false, 'writeFile 호출 금지');
  assert.equal(/fs\.appendFile\(/.test(src), false, 'appendFile 호출 금지');
  assert.equal(/fs\.appendFileSync\(/.test(src), false, 'appendFileSync 호출 금지');
  assert.equal(/fs\.unlinkSync\(/.test(src), false, 'unlinkSync 호출 금지');
  assert.equal(/fs\.unlink\(/.test(src), false, 'unlink 호출 금지');
  assert.equal(/fs\.rmSync\(/.test(src), false, 'rmSync 호출 금지');
  assert.equal(/fs\.rm\(/.test(src), false, 'rm 호출 금지');
  assert.equal(/fs\.rmdir\(/.test(src), false, 'rmdir 호출 금지');
});

test('RK2: 실험 결과 디렉터리 파일 개수 변화 없음 (읽기 전용 스냅샷)', () => {
  const dir = path.join(ROOT, 'experiments/strategy-expansion-20261030');
  const entries = fs.readdirSync(dir).filter((e) => !e.startsWith('.'));
  // 이 테스트는 개수만 확인 (실행 전후 비교 아님) — 최소 존재 확인
  assert.ok(entries.length >= 6, `기대 >= 6, 실제 ${entries.length}`);
});
