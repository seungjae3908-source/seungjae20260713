// block19-orchestrator.test.mjs
// BLOCK 19 Step 6-B — AI Paper Pipeline 단위 테스트 (네트워크 0건)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PIPELINE_DEFAULTS,
  getRuntimePaths,
  loadOrInitStates,
  processAIPaperBar,
  persistAIPaperState,
  generateReport,
  validateMarketInput,
  SAFE_LIVE_ENV,
} from '../src/orchestrator-ai-paper.mjs';
import { DIRECTION, STRATEGY } from '../src/ai-strategy-selector.mjs';

const NOW = 1_700_000_000_000;

function newTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'b19o-'));
}

function upIndicators(over = {}) {
  return {
    atr: 0.5, adx: 35, rsi: 60, macdHistogram: 0.5, bbWidth: 0.02,
    vwap: 98, currentPrice: 100, ...over,
  };
}
function downIndicators(over = {}) {
  return {
    atr: 0.5, adx: 35, rsi: 35, macdHistogram: -0.5, bbWidth: 0.02,
    vwap: 102, currentPrice: 100, ...over,
  };
}
function sideIndicators(over = {}) {
  return {
    atr: 0.5, adx: 15, rsi: 50, macdHistogram: 0.01, bbWidth: 0.02,
    vwap: 100, currentPrice: 100, ...over,
  };
}
function highVolIndicators(over = {}) {
  return {
    atr: 5, adx: 35, rsi: 60, macdHistogram: 0.5, bbWidth: 0.10,
    vwap: 98, currentPrice: 100, ...over,
  };
}
function candle(over = {}) {
  return { open: 99, high: 101, low: 98, close: 100, volume: 1000, ts: NOW, ...over };
}

function baseArgs(over = {}) {
  const dir = newTmpDir();
  return {
    symbol: 'BTCUSDT',
    candle: candle(),
    indicators: upIndicators(),
    candlesCount: 50,
    bConfig: { ...PIPELINE_DEFAULTS.bConfigDefault },
    aiState: null,
    bState: null,
    env: null, // safe default = {}
    explicitApprovalToken: null,
    expectedApprovalToken: null,
    marketData: { lastUpdateMs: NOW - 1000, nowMs: NOW },
    accountData: { lastAccountSyncMs: NOW - 5000, expected: null, observed: null },
    config: {},
    nowMs: NOW,
    paths: getRuntimePaths(path.join(dir, 'paper-ai')),
    ...over,
  };
}

// ────────────────────────────────────────────────
// A. 시장 데이터 검증
// ────────────────────────────────────────────────
test('A1: validateMarketInput — 정상', () => {
  const r = validateMarketInput({ candle: candle(), indicators: upIndicators(), nowMs: NOW });
  assert.equal(r.ok, true);
});

test('A2: validateMarketInput — candle 없음', () => {
  const r = validateMarketInput({ candle: null, indicators: upIndicators(), nowMs: NOW });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('CANDLE_MISSING'));
});

test('A3: validateMarketInput — currentPrice 음수', () => {
  const r = validateMarketInput({
    candle: candle(), indicators: upIndicators({ currentPrice: -1 }), nowMs: NOW,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('CURRENT_PRICE_INVALID'));
});

// ────────────────────────────────────────────────
// B. 국면별 전략 선택
// ────────────────────────────────────────────────
test('B1: 상승 국면 → LONG_TRAILING_GRID', () => {
  const r = processAIPaperBar(baseArgs({ indicators: upIndicators() }));
  assert.equal(r.ok, true);
  assert.equal(r.aiDecision.strategy, STRATEGY.LONG_TRAILING_GRID);
  assert.equal(r.aiDecision.direction, DIRECTION.LONG);
  assert.equal(r.gate.allowed, false);
  assert.equal(r.gate.realApiCalled, false);
});

test('B2: 하락 국면 → SHORT_TRAILING_GRID', () => {
  const r = processAIPaperBar(baseArgs({ indicators: downIndicators() }));
  assert.equal(r.aiDecision.strategy, STRATEGY.SHORT_TRAILING_GRID);
  assert.equal(r.aiDecision.direction, DIRECTION.SHORT);
});

test('B3: 횡보 국면 → NEUTRAL_GRID (Step 6-C 독립 paper 경로)', () => {
  const r = processAIPaperBar(baseArgs({ indicators: sideIndicators() }));
  assert.equal(r.aiDecision.strategy, STRATEGY.NEUTRAL_GRID);
  assert.equal(r.aiDecision.direction, DIRECTION.NEUTRAL);
  // Step 6-C: NEUTRAL_GRID 는 독립 paper 경로로 실행됨.
  //   - 통과 시: paperResult.kind === 'NEUTRAL_GRID'
  //   - 미통과 시: NEUTRAL_PAPER_SKIP:* reason 기록
  // (기존 'PAPER_SKIP' 단일값 가정 폐기 — 기능 확장 반영, 테스트 삭제 아님)
  if (r.paperResult) {
    assert.equal(r.paperResult.kind, 'NEUTRAL_GRID');
    assert.equal(r.paperResult.realApiCalled, false);
  } else {
    assert.ok(
      r.reasons.some((x) => x.startsWith('NEUTRAL_PAPER_SKIP')),
      `NEUTRAL 스킵 시 사유 필요: ${JSON.stringify(r.reasons)}`,
    );
  }
});

test('B4: HIGH_VOLATILITY → 신규 진입 차단', () => {
  const r = processAIPaperBar(baseArgs({ indicators: highVolIndicators() }));
  assert.equal(r.aiDecision.allowNewEntry, false);
  assert.equal(r.aiDecision.strategy, STRATEGY.NO_NEW_ENTRY);
  assert.equal(r.paperResult, null);
});

test('B5: FAIL_CLOSED (데이터 오래됨) → 신규 진입 차단', () => {
  const r = processAIPaperBar(baseArgs({
    indicators: upIndicators(),
    marketData: { lastUpdateMs: NOW - 10 * 60_000, nowMs: NOW },
  }));
  assert.equal(r.aiDecision.failClosed, true);
  assert.equal(r.aiDecision.allowNewEntry, false);
  assert.equal(r.paperResult, null);
});

// ────────────────────────────────────────────────
// C. 위험관리 / Paper 실행
// ────────────────────────────────────────────────
test('C1: 정상 상승 → paper 실행 ok', () => {
  const r = processAIPaperBar(baseArgs());
  assert.equal(r.ok, true);
  // quantity 계산되어 submitPaperOrder 호출
  assert.ok(r.paperResult, 'paperResult 존재해야');
});

test('C2: 주문 수량 0 (자본 부족) → paper 스킵 또는 실패', () => {
  const r = processAIPaperBar(baseArgs({
    config: { availableCapitalKrw: 100 },
  }));
  // 자본 부족으로 plan 자체가 fail 일 수 있음
  assert.ok(
    r.paperResult == null ||
    r.paperResult.ok === false ||
    r.aiDecision.allowNewEntry === false,
  );
});

test('C3: 비정상 가격 (candle close 음수) → FAIL_CLOSED', () => {
  const r = processAIPaperBar(baseArgs({
    candle: candle({ close: -1 }),
  }));
  assert.equal(r.ok, false);
  assert.equal(r.failClosed, true);
});

test('C4: 비정상 지표 (currentPrice=0) → FAIL_CLOSED', () => {
  const r = processAIPaperBar(baseArgs({
    indicators: upIndicators({ currentPrice: 0 }),
  }));
  assert.equal(r.ok, false);
  assert.equal(r.failClosed, true);
});

// ────────────────────────────────────────────────
// D. 상태 저장 / 복구 / 격리
// ────────────────────────────────────────────────
test('D1: 상태 저장 후 재로드 → AI/B 독립 복원', () => {
  const dir = newTmpDir();
  const paths = getRuntimePaths(path.join(dir, 'paper-ai'));

  // 1차 처리
  const r1 = processAIPaperBar(baseArgs({ paths }));
  assert.equal(r1.ok, true);
  const p = persistAIPaperState({ paths, aiState: r1.aiState, bState: r1.bState });
  assert.equal(p.aiSaved, true);
  assert.equal(p.bSaved, true);

  // 파일 존재 확인
  assert.equal(fs.existsSync(paths.aiState), true);
  assert.equal(fs.existsSync(paths.bState), true);

  // 재로드
  const st = loadOrInitStates({ paths, nowMs: NOW });
  assert.ok(st.aiState);
  assert.ok(st.bState);
  assert.notEqual(st.aiState, st.bState); // 서로 다른 객체
});

test('D2: AI/B 상태 파일 경로 격리 확인', () => {
  const paths = getRuntimePaths('/tmp/test-b19');
  assert.notEqual(paths.aiState, paths.bState);
  assert.ok(paths.aiState.endsWith('state-ai.json'));
  assert.ok(paths.bState.endsWith('state-b.json'));
});

test('D3: 손상된 AI 상태 파일 → fail-closed 로드 + 격리', () => {
  const dir = newTmpDir();
  const paths = getRuntimePaths(path.join(dir, 'paper-ai'));
  fs.mkdirSync(path.dirname(paths.aiState), { recursive: true });
  fs.writeFileSync(paths.aiState, 'NOT_JSON_AT_ALL', 'utf8');
  const st = loadOrInitStates({ paths, nowMs: NOW });
  assert.equal(st.aiCorrupt, true);
  assert.ok(st.aiQuarantinePath);
  assert.equal(fs.existsSync(st.aiQuarantinePath), true);
  // 새 상태로 진행 가능
  assert.ok(st.aiState);
});

test('D4: 손상된 B 상태 파일 → B만 복구, AI 무영향', () => {
  const dir = newTmpDir();
  const paths = getRuntimePaths(path.join(dir, 'paper-ai'));
  fs.mkdirSync(path.dirname(paths.bState), { recursive: true });
  // AI 정상, B 손상
  fs.writeFileSync(paths.bState, 'CORRUPTED', 'utf8');
  const st = loadOrInitStates({ paths, nowMs: NOW });
  assert.equal(st.aiCorrupt, false);
  assert.equal(st.bState, null); // B만 null, AI는 정상 초기화
  assert.ok(st.aiState);
});

// ────────────────────────────────────────────────
// E. B Trailing 병렬 + 실패 격리
// ────────────────────────────────────────────────
test('E1: AI + B 병렬 실행 — B 결과 ok', () => {
  const r = processAIPaperBar(baseArgs());
  assert.equal(r.ok, true);
  assert.ok(r.bResult);
  assert.equal(r.bResult.ok, true);
  assert.ok(r.bState);
});

test('E2: B 실행 실패 → AI 상태 보존', () => {
  const r = processAIPaperBar(baseArgs({
    bConfig: { gridCount: 0, investmentUsdt: -1, leverage: 0, rangePct: 0 },
  }));
  // B 설정이 무효라 예외 발생 → bResult.ok=false, aiState는 정상 진행
  assert.ok(r.bResult);
  assert.equal(r.bResult.ok, false);
  assert.equal(r.ok, true); // 전체 파이프라인 ok (AI는 정상)
});

test('E3: AI 스킵(고변동성) → B 독립 실행 유지', () => {
  const r = processAIPaperBar(baseArgs({ indicators: highVolIndicators() }));
  assert.equal(r.aiDecision.allowNewEntry, false);
  assert.ok(r.bResult);
  assert.equal(r.bResult.ok, true);
});

// ────────────────────────────────────────────────
// F. LIVE 게이트 / 안전
// ────────────────────────────────────────────────
test('F1: 정상 plan 에서도 LIVE 게이트 allowed=false', () => {
  const r = processAIPaperBar(baseArgs());
  assert.equal(r.gate.allowed, false);
  assert.equal(r.gate.wouldExecute, false);
  assert.equal(r.gate.realApiCalled, false);
});

test('F2: env 전체 OFF 에서도 LIVE 게이트 차단', () => {
  const r = processAIPaperBar(baseArgs({ env: {} }));
  assert.equal(r.gate.allowed, false);
});

test('F3: NEUTRAL/NO_ENTRY/FAIL_CLOSED 에서도 allowed=false', () => {
  const cases = [
    baseArgs({ indicators: sideIndicators() }),
    baseArgs({ indicators: highVolIndicators() }),
    baseArgs({ marketData: { lastUpdateMs: NOW - 10 * 60_000, nowMs: NOW } }),
  ];
  for (const args of cases) {
    const r = processAIPaperBar(args);
    assert.equal(r.gate.allowed, false);
    assert.equal(r.gate.realApiCalled, false);
  }
});

// ────────────────────────────────────────────────
// G. 리포트 생성
// ────────────────────────────────────────────────
test('G1: 리포트 파일 생성 + source=MOCK_DATA', () => {
  const dir = newTmpDir();
  const paths = getRuntimePaths(path.join(dir, 'paper-ai'));
  const r = processAIPaperBar(baseArgs({ paths }));
  const rep = generateReport({
    paths, nowMs: NOW, aiState: r.aiState, bState: r.bState, history: [],
  });
  assert.ok(fs.existsSync(rep.reportPath));
  assert.equal(rep.report.source, PIPELINE_DEFAULTS.sourceLabel);
  assert.equal(rep.report.source, 'MOCK_DATA');
});

// ────────────────────────────────────────────────
// H. 정적 보증 / 안전 증거
// ────────────────────────────────────────────────
test('H1: orchestrator 파일에 fetch/axios/bitget-adapter import 없음', () => {
  const p = '/opt/smart-grid-dev/packages/smart-grid-engine/src/orchestrator-ai-paper.mjs';
  const src = fs.readFileSync(p, 'utf8');
  assert.equal(/\bfetch\s*\(/.test(src), false, 'fetch 사용 금지');
  assert.equal(/import.*axios/.test(src), false, 'axios import 금지');
  assert.equal(/from ['"]\.\/bitget-adapter/.test(src), false, 'bitget-adapter import 금지');
  assert.equal(/bitget-private/.test(src), false, 'bitget-private import 금지');
});

test('H2: 기존 paper-abc 접근 0 (정적)', () => {
  const p = '/opt/smart-grid-dev/packages/smart-grid-engine/src/orchestrator-ai-paper.mjs';
  const src = fs.readFileSync(p, 'utf8');
  assert.equal(src.includes('paper-abc'), false, 'paper-abc 경로 참조 금지');
});

test('H3: 안전 상수 (SAFE_LIVE_ENV) 노출 확인', () => {
  assert.equal(SAFE_LIVE_ENV.LIVE_TRADING, false);
  assert.equal(SAFE_LIVE_ENV.AUTO_TRADING, false);
  assert.equal(SAFE_LIVE_ENV.REAL_ORDER_ENABLED, false);
  assert.equal(SAFE_LIVE_ENV.PRIVATE_TRADING_API_ALLOWED, false);
  assert.equal(SAFE_LIVE_ENV.EXECUTION_AUTHORITY, 'NONE');
});
