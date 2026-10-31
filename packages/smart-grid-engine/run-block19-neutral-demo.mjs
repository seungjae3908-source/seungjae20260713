// run-block19-neutral-demo.mjs — NEUTRAL_GRID 전용 데모 (MOCK_DATA only)
import {
  PIPELINE_DEFAULTS, getRuntimePaths, loadOrInitStates,
  processAIPaperBar, persistAIPaperState, generateReport,
} from './src/orchestrator-ai-paper.mjs';

function buildSidewaysFixtures() {
  const NOW = 1_700_000_000_000;
  const bars = [];
  for (let i = 0; i < 10; i++) {
    const price = 100 + (i % 2 === 0 ? 0.1 : -0.1);
    bars.push({
      nowMs: NOW + i * 4 * 3600_000,
      candle: {
        open: price - 0.2, high: price + 0.5, low: price - 0.5,
        close: price, volume: 900 + i * 20, ts: NOW + i * 4 * 3600_000,
      },
      indicators: { atr: 0.5, adx: 15, rsi: 50, macdHistogram: 0.01, bbWidth: 0.02, vwap: 100, currentPrice: price },
    });
  }
  return bars;
}

async function main() {
  console.log('════════ BLOCK 19 NEUTRAL DEMO (MOCK_DATA) ════════');
  console.log('source = MOCK_DATA');
  console.log('network = NONE');
  console.log('realOrder = NONE');
  console.log('');

  const paths = getRuntimePaths();
  const st = loadOrInitStates({ paths });
  let aiState = st.aiState;
  let bState = st.bState;
  let neutralState = st.neutralState || null;
  const history = [];

  for (const bar of buildSidewaysFixtures()) {
    const r = processAIPaperBar({
      symbol: 'BTCUSDT', candle: bar.candle, indicators: bar.indicators,
      candlesCount: 50, bConfig: { ...PIPELINE_DEFAULTS.bConfigDefault },
      aiState, bState, neutralState, env: {},
      marketData: { lastUpdateMs: bar.nowMs - 1000, nowMs: bar.nowMs },
      accountData: { lastAccountSyncMs: bar.nowMs - 5000, expected: null, observed: null },
      config: {}, nowMs: bar.nowMs, paths,
    });
    history.push({ nowMs: bar.nowMs, strategy: r.aiDecision?.strategy });
    if (r.ok) {
      aiState = r.aiState; bState = r.bState;
      if (r.neutralState) neutralState = r.neutralState;
    }
  }

  const p = persistAIPaperState({ paths, aiState, bState, neutralState });
  console.log(`AI state save:      ${p.aiSaved}`);
  console.log(`B  state save:      ${p.bSaved}`);
  console.log(`NEUTRAL state save: ${p.neutralSaved}`);

  const rep = generateReport({ paths, nowMs: Date.now(), aiState, bState, history });
  console.log(`report: ${rep.reportPath}`);
  console.log(`report.source: ${rep.report.source}`);
  console.log('');
  console.log('════════ NEUTRAL 요약 ════════');
  console.log(`NEUTRAL fills:  ${neutralState?.fills?.length ?? 0}`);
  console.log(`NEUTRAL rt:     ${neutralState?.roundTrips ?? 0}`);
  console.log(`NEUTRAL pnl:    ${neutralState?.realizedPnl ?? 0}`);
  console.log(`NEUTRAL boundary: ${neutralState?.boundaryState ?? 'n/a'}`);
  console.log('LIVE gate: allowed=false (always)');
  console.log('realApiCalled=false, realOrder=0');
}

if (process.env.AI_PAPER_IMPORT_ONLY !== '1') {
  main().catch((e) => { console.error(e); process.exit(1); });
}
