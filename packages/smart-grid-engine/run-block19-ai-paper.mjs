// run-block19-ai-paper.mjs
// BLOCK 19 Step 6-B — AI Paper CLI (MOCK_DATA only, 네트워크 0건)
//
// 실행: node run-block19-ai-paper.mjs
//
// 원칙:
//   - 실제 Bitget API 호출 없음 (bitget-adapter import 0)
//   - fixture 데이터만 사용
//   - 출력 source: MOCK_DATA 명시
//   - 상태는 .runtime/paper-ai/ 에 격리 저장

import {
  PIPELINE_DEFAULTS,
  getRuntimePaths,
  loadOrInitStates,
  processAIPaperBar,
  persistAIPaperState,
  generateReport,
} from './src/orchestrator-ai-paper.mjs';

function buildFixtures() {
  const NOW = 1_700_000_000_000;
  const bars = [];
  for (let i = 0; i < 10; i++) {
    const price = 100 + i * 0.3;
    bars.push({
      nowMs: NOW + i * 4 * 3600_000,
      candle: {
        open: price - 0.2, high: price + 0.4, low: price - 0.4,
        close: price, volume: 1000 + i * 10, ts: NOW + i * 4 * 3600_000,
      },
      indicators: {
        atr: 0.5, adx: 35, rsi: 60 + i * 0.2, macdHistogram: 0.5,
        bbWidth: 0.02, vwap: price - 1, currentPrice: price,
      },
    });
  }
  return bars;
}

async function main() {
  console.log('════════ BLOCK 19 AI PAPER CLI (MOCK_DATA) ════════');
  console.log('source = MOCK_DATA');
  console.log('network = NONE');
  console.log('realOrder = NONE');
  console.log('');

  const paths = getRuntimePaths();
  console.log(`runtime: ${paths.dir}`);

  const st = loadOrInitStates({ paths });
  if (st.aiCorrupt) {
    console.log(`⚠️  AI state 손상 → 격리: ${st.aiQuarantinePath}`);
  }

  let aiState = st.aiState;
  let bState = st.bState;
  let neutralState = st.neutralState || null;
  const history = [];

  for (const bar of buildFixtures()) {
    const r = processAIPaperBar({
      symbol: 'BTCUSDT',
      candle: bar.candle,
      indicators: bar.indicators,
      candlesCount: 50,
      bConfig: { ...PIPELINE_DEFAULTS.bConfigDefault },
      aiState,
      bState,
      neutralState,
      env: {},
      marketData: { lastUpdateMs: bar.nowMs - 1000, nowMs: bar.nowMs },
      accountData: { lastAccountSyncMs: bar.nowMs - 5000, expected: null, observed: null },
      config: {},
      nowMs: bar.nowMs,
      paths,
    });
    history.push({
      nowMs: bar.nowMs,
      ok: r.ok,
      regime: r.aiDecision?.regime ?? null,
      strategy: r.aiDecision?.strategy ?? null,
      paperOk: r.paperResult?.ok ?? null,
      bOk: r.bResult?.ok ?? null,
      gateAllowed: r.gate?.allowed,
    });
    if (r.ok) {
      aiState = r.aiState;
      bState = r.bState;
      if (r.neutralState) neutralState = r.neutralState;
    }
  }

  const p = persistAIPaperState({ paths, aiState, bState, neutralState });
  console.log(`AI state save: ${p.aiSaved} (err=${p.aiError || '-'})`);
  console.log(`B  state save: ${p.bSaved} (err=${p.bError || '-'})`);

  const rep = generateReport({
    paths, nowMs: Date.now(), aiState, bState, history,
  });
  console.log(`report: ${rep.reportPath}`);
  console.log(`report.source: ${rep.report.source}`);
  console.log('');
  console.log('════════ summary ════════');
  console.log(`AI  usdtBalance: ${rep.report.ai.usdtBalance}`);
  console.log(`AI  positions:   ${rep.report.ai.positionsCount}`);
  console.log(`AI  fills:       ${rep.report.ai.fillsCount}`);
  console.log(`B   trades:      ${rep.report.b.metricsB?.trades ?? 'n/a'}`);
  console.log(`B   netPnl:      ${rep.report.b.metricsB?.netPnl ?? 'n/a'}`);
  console.log(`NEUTRAL saved:  ${p.neutralSaved} (err=${p.neutralError || '-'})`);
  console.log('');
  console.log('LIVE gate: allowed=false (always)');
  console.log('realApiCalled=false');
  console.log('realOrder=0');
}

if (process.env.AI_PAPER_IMPORT_ONLY !== '1') {
  main().catch((e) => { console.error(e); process.exit(1); });
}
