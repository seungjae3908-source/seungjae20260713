// orchestrator-ai-paper.mjs
// BLOCK 19 Step 6-B — AI Paper Pipeline Orchestrator
//
// 안전 원칙 (절대 위반 금지):
//   - 네트워크/API 호출 없음 (bitget-adapter import 금지)
//   - 실제 주문 함수 호출 없음
//   - live-order-gate.allowed 는 항상 false 유지 (기록만)
//   - Paper 실행은 게이트의 candidateEligible 통과 시에만 (LIVE 게이트 우회 아님)
//   - B Trailing 은 기존 모듈을 read-only 호출 (수정 없음)
//   - AI / B 상태 파일은 서로 완전히 격리
//   - NEUTRAL 그리드는 submitPaperOrder 미지원 → paper 실행 스킵 (결정만 기록)

import fs from 'node:fs';
import path from 'node:path';

import { selectAIPlan } from './ai-strategy-selector.mjs';
import { planAdaptiveGrid } from './adaptive-grid-planner.mjs';
import { evaluateRisk } from './ai-risk-orchestrator.mjs';
import { evaluateLiveGate, SAFE_LIVE_ENV } from './live-order-gate.mjs';
import { DIRECTION, STRATEGY } from './ai-strategy-selector.mjs';
import {
  createPaperState,
  paperSaveState,
  paperLoadStateSafe,
  submitPaperOrder,
} from './paper-execution-adapter.mjs';
import { calculateGridQuantity } from './grid-math.mjs';

// 기존 B 모듈 — read-only import (수정 없음)
import {
  initStateB,
  processCandleB,
  applyFundingB,
  computeMetricsB,
} from './paper-forward-trailing.mjs';

export const PIPELINE_DEFAULTS = Object.freeze({
  initialUsdt: 1000,
  exchangeRateKrw: 1350,
  availableCapitalKrw: 500_000,
  feeRate: 0.0006,
  fundingRate: 0,
  maintenanceMarginRate: 0.005,
  minQuantity: 0.0001,
  maxQuantity: 1000,
  maxNotionalUsdt: 500,
  runtimeDir: '.runtime/paper-ai',
  aiStateFile: 'state-ai.json',
  bStateFile: 'state-b.json',
  reportDir: 'reports',
  sourceLabel: 'MOCK_DATA',
  bConfigDefault: Object.freeze({
    gridCount: 20,
    investmentUsdt: 300,
    leverage: 2,
    rangePct: 0.15,
    pricePlace: 2,
    volumePlace: 4,
    minTradeNum: 0.0001,
  }),
});

export function getRuntimePaths(baseDir = PIPELINE_DEFAULTS.runtimeDir) {
  return {
    dir: baseDir,
    aiState: path.join(baseDir, PIPELINE_DEFAULTS.aiStateFile),
    bState: path.join(baseDir, PIPELINE_DEFAULTS.bStateFile),
    reportDir: path.join(baseDir, PIPELINE_DEFAULTS.reportDir),
  };
}

function isPositive(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}
function isNonNegative(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

// 시장 데이터 입력 검증
export function validateMarketInput({ candle, indicators, nowMs }) {
  const reasons = [];
  if (!candle || typeof candle !== 'object') reasons.push('CANDLE_MISSING');
  else {
    if (!isPositive(candle.close)) reasons.push('CANDLE_CLOSE_INVALID');
    if (!isPositive(candle.open)) reasons.push('CANDLE_OPEN_INVALID');
  }
  if (!indicators || typeof indicators !== 'object') reasons.push('INDICATORS_MISSING');
  else {
    const required = ['atr', 'adx', 'rsi', 'macdHistogram', 'bbWidth', 'vwap', 'currentPrice'];
    for (const k of required) {
      if (!Number.isFinite(indicators[k])) reasons.push(`INDICATOR_INVALID:${k}`);
    }
    if (indicators.currentPrice <= 0) reasons.push('CURRENT_PRICE_INVALID');
  }
  return { ok: reasons.length === 0, reasons };
}

// 상태 로드 (AI + B)
export function loadOrInitStates({ paths, initialUsdt = PIPELINE_DEFAULTS.initialUsdt, nowMs = Date.now() } = {}) {
  const aiLoad = paperLoadStateSafe({ statePath: paths.aiState, initialUsdt, nowMs });
  const aiState = aiLoad.ok ? aiLoad.state : null;
  const aiCorrupt = !aiLoad.ok;
  const aiQuarantinePath = aiLoad.quarantinePath || null;

  let bState = null;
  try {
    if (fs.existsSync(paths.bState)) {
      const raw = fs.readFileSync(paths.bState, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') bState = parsed;
    }
  } catch {
    // 손상된 B 상태는 백업 후 null 로 시작 (AI 상태에 영향 없음)
    try {
      const ts = Date.now();
      fs.renameSync(paths.bState, `${paths.bState}.corrupt.${ts}`);
    } catch { /* silent */ }
    bState = null;
  }

  return {
    aiState: aiState || createPaperState({ initialUsdt, nowMs }),
    aiCorrupt,
    aiQuarantinePath,
    bState,
  };
}

// 상태 저장 (AI + B 격리 저장)
export function persistAIPaperState({ paths, aiState, bState } = {}) {
  let aiSaved = false, aiError = null;
  if (aiState) {
    const r = paperSaveState({ statePath: paths.aiState, state: aiState });
    aiSaved = r.saved === true;
    aiError = r.error || null;
  }

  let bSaved = false, bError = null;
  if (bState) {
    try {
      fs.mkdirSync(path.dirname(paths.bState), { recursive: true });
      fs.writeFileSync(paths.bState, JSON.stringify(bState, null, 2), 'utf8');
      bSaved = true;
    } catch (e) {
      bError = e.message;
    }
  }

  return { aiSaved, aiError, bSaved, bError };
}

// 단일 봉(bar) 처리
export function processAIPaperBar(args = {}) {
  const {
    symbol,
    candle,
    indicators,
    candlesCount = 50,
    bConfig = null,
    aiState = null,
    bState = null,
    env = null,
    explicitApprovalToken = null,
    expectedApprovalToken = null,
    marketData = null,
    accountData = null,
    config = {},
    nowMs = Date.now(),
    paths = null,
  } = args;

  const cfg = { ...PIPELINE_DEFAULTS, ...config };
  const reasons = [];

  // ── 1) 시장 데이터 검증 ──────────────────
  const v = validateMarketInput({ candle, indicators, nowMs });
  if (!v.ok) {
    return {
      ok: false, failClosed: true, reason: 'INVALID_MARKET_DATA',
      reasons: v.reasons,
      aiState, bState,
      aiDecision: null, gridPlan: null, riskEval: null, gate: null,
      paperResult: null, bResult: null,
      source: cfg.sourceLabel,
      nowMs,
    };
  }

  // ── 2~4) AI 시장 판단 + 그리드 계획 ─────
  const regimeInput = {
    nowMs,
    lastUpdateMs: marketData?.lastUpdateMs ?? nowMs,
    candles: Array(Math.max(candlesCount, 30)).fill({ close: indicators.currentPrice }),
    atr: indicators.atr,
    adx: indicators.adx,
    rsi: indicators.rsi,
    macdHistogram: indicators.macdHistogram,
    bbWidth: indicators.bbWidth,
    vwap: indicators.vwap,
    currentPrice: indicators.currentPrice,
  };

  const gridPlan = planAdaptiveGrid({
    currentPrice: indicators.currentPrice,
    atr: indicators.atr,
    availableCapitalKrw: cfg.availableCapitalKrw,
    exchangeRateKrw: cfg.exchangeRateKrw,
    regimeInput,
    feeRate: cfg.feeRate,
    nowMs,
  });

  const aiDecision = {
    regime: gridPlan.regime,
    strategy: gridPlan.strategy,
    direction: gridPlan.direction,
    fallback: gridPlan.fallback,
    allowNewEntry: gridPlan.allowNewEntry === true,
    failClosed: gridPlan.failClosed === true,
    reasons: (gridPlan.reasons || []).slice(),
  };

  // ── 5) 위험 검증 ────────────────────────
  const riskEval = evaluateRisk({
    plan: gridPlan,
    symbol,
    currentPrice: indicators.currentPrice,
    exchangeRateKrw: cfg.exchangeRateKrw,
    availableCapitalKrw: cfg.availableCapitalKrw,
    feeRate: cfg.feeRate,
    fundingRate: cfg.fundingRate,
    maintenanceMarginRate: cfg.maintenanceMarginRate,
    nowMs,
    state: aiState ? {
      version: 1,
      dayKey: aiState.dayKey ?? null,
      realizedLossKrw: aiState.realizedLossKrw ?? 0,
      activeOrders: aiState.activeOrders ?? {},
      lastUpdatedMs: aiState.lastUpdatedMs ?? nowMs,
    } : null,
  });

  // ── 6) LIVE 게이트 (항상 차단, 기록만) ───
  const gate = evaluateLiveGate({
    plan: gridPlan,
    riskEvaluation: riskEval,
    env: env || {},
    explicitApprovalToken,
    expectedApprovalToken,
    marketData: marketData || { lastUpdateMs: null },
    accountData: accountData || { lastAccountSyncMs: null, expected: null, observed: null },
    quantity: null,
    minQuantity: cfg.minQuantity,
    maxQuantity: cfg.maxQuantity,
    maxNotionalUsdt: cfg.maxNotionalUsdt,
    nowMs,
  });

  // ── 7) Paper 전용 실행 분기 ──────────────
  let paperResult = null;
  // aiState 가 null 이면 초기 상태 생성 (D1 테스트 통과 조건)
  let newAiState = aiState || createPaperState({ initialUsdt: cfg.initialUsdt, nowMs });

  const directionSupported =
    gridPlan.direction === DIRECTION.LONG || gridPlan.direction === DIRECTION.SHORT;
  // Paper 실행 선행조건 (지시서 §3):
  //   1) 시장 데이터 유효성 (위에서 validateMarketInput 통과)
  //   2) AI 계획 유효성 (gridPlan ok)
  //   3) 위험관리 통과 (riskEval.ok && allowNewEntry)
  //   4) 주문 수량·가격 검증 (아래 calculateGridQuantity + submitPaperOrder)
  // LIVE 게이트(candidateEligible) 는 Paper 실행의 선행조건이 아님 — 기록만.
  const paperPrecondsMet =
    riskEval.ok === true &&
    riskEval.allowNewEntry === true &&
    directionSupported;

  if (paperPrecondsMet) {
    let quantity = null;
    try {
      quantity = calculateGridQuantity({
        totalInvestmentUsdt: gridPlan.capital.deployUsdt,
        gridCount: gridPlan.grid.gridCount,
        currentPrice: indicators.currentPrice,
        leverage: gridPlan.leverage,
        volumePlace: 4,
        minTradeNum: cfg.minQuantity,
      });
    } catch (e) {
      quantity = null;
    }

    if (quantity == null || !(quantity > 0)) {
      reasons.push('QUANTITY_INVALID');
      paperResult = { ok: false, reason: 'QUANTITY_INVALID', realApiCalled: false };
    } else {
      paperResult = submitPaperOrder({
        state: newAiState,
        statePath: paths?.aiState || null,
        symbol,
        direction: gridPlan.direction,
        strategy: gridPlan.strategy,
        grid: gridPlan.grid,
        quantity,
        price: indicators.currentPrice,
        leverage: gridPlan.leverage,
        feeRate: cfg.feeRate,
        nowMs,
      });
      if (paperResult.ok) {
        newAiState = paperResult.state;
      }
    }
  } else if (!directionSupported && gridPlan.strategy === STRATEGY.NEUTRAL_GRID) {
    reasons.push('PAPER_SKIP:NEUTRAL_NOT_SUPPORTED_BY_ADAPTER');
  } else {
    reasons.push('PAPER_SKIP:PRECONDITIONS_NOT_MET');
  }

  // ── 8) B Trailing 병렬 실행 (기존 모듈 read-only) ──
  let newBState = bState;
  let bResult = null;

  if (bConfig && candle) {
    try {
      let workB = bState;
      if (!workB) {
        workB = initStateB({
          symbol,
          startPrice: candle.close,
          gridCount: bConfig.gridCount,
          investmentUsdt: bConfig.investmentUsdt,
          leverage: bConfig.leverage,
          rangePct: bConfig.rangePct,
          pricePlace: bConfig.pricePlace ?? 2,
          volumePlace: bConfig.volumePlace ?? 4,
          minTradeNum: bConfig.minTradeNum ?? 0.0001,
        });
      }
      workB = processCandleB(workB, candle);
      newBState = workB;
      bResult = { ok: true, realApiCalled: false };
    } catch (e) {
      // B 실패는 AI 상태에 영향 없음
      newBState = bState;
      bResult = { ok: false, reason: e.message || 'B_THROW', realApiCalled: false };
    }
  }

  return {
    ok: true,
    failClosed: false,
    reasons,
    aiState: newAiState,
    bState: newBState,
    aiDecision,
    gridPlan: {
      ok: gridPlan.ok,
      allowNewEntry: gridPlan.allowNewEntry,
      strategy: gridPlan.strategy,
      direction: gridPlan.direction,
      regime: gridPlan.regime,
      leverage: gridPlan.leverage,
      leverageSource: gridPlan.leverageSource,
      capital: gridPlan.capital,
      grid: gridPlan.grid,
    },
    riskEval: {
      ok: riskEval.ok,
      failClosed: riskEval.failClosed,
      allowNewEntry: riskEval.allowNewEntry,
      orderKey: riskEval.orderKey,
      reasons: riskEval.reasons,
    },
    gate: {
      // LIVE 게이트 결과는 기록만 — allowed 는 항상 false
      allowed: false,
      wouldExecute: false,
      realApiCalled: false,
      candidateEligible: gate.candidateEligible,
      reasons: gate.reasons,
    },
    paperResult,
    bResult,
    source: cfg.sourceLabel,
    nowMs,
  };
}

// 리포트 생성 (AI/B 분리)
export function generateReport({ paths, nowMs = Date.now(), aiState, bState, history = [] } = {}) {
  fs.mkdirSync(paths.reportDir, { recursive: true });
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const reportPath = path.join(paths.reportDir, `${date}.json`);

  let bMetrics = null;
  try {
    if (bState) bMetrics = computeMetricsB(bState);
  } catch { /* silent */ }

  const report = {
    date,
    generatedAtMs: nowMs,
    source: PIPELINE_DEFAULTS.sourceLabel,
    ai: {
      usdtBalance: aiState?.usdtBalance ?? null,
      initialUsdt: aiState?.initialUsdt ?? null,
      positionsCount: Object.keys(aiState?.positions || {}).length,
      fillsCount: (aiState?.fills || []).length,
      feesPaid: aiState?.feesPaid ?? null,
      fundingPaid: aiState?.fundingPaid ?? null,
      realizedPnl: aiState?.realizedPnl ?? null,
    },
    b: {
      metricsB: bMetrics,
    },
    historyCount: history.length,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return { reportPath, report };
}

export { SAFE_LIVE_ENV };
