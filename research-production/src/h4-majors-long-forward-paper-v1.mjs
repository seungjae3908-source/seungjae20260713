// Forward paper ledger for the one rule that passed round 2 of the flip research:
// H4_MAJORS_LONG (4h bars, BTC/ETH/SOL/XRP/BNB/DOGE, long only, BTC drawdown filter,
// half profit at 1.5R then breakeven + ATR trail). Research only, no orders.
//
// The generic exploratory ledger cannot express this rule (1h lanes, stateless atoms),
// so this module applies the SAME evidence standard to it:
//   - only signals on candles at or after the unseen forward start (2026-08-10) count;
//     earlier candles are indicator warm-up only (the sealed 2026 holdout is not traded);
//   - `strict` counts only signals after the rule was registered (REGISTERED_AT);
//   - promotion: >= 30 strict closed trades, 95% lower bound of mean R > 0, >= 3 symbols.
// Trades are recomputed from public candles each run, so the ledger is deterministic.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { FORWARD_PAPER_START_MS } from './extended-exit-backtest-v1.mjs';
import { sampleSummaryV1 } from './exploratory-paper-ledger-v1.mjs';
import { LONG_SHORT_FLIP_RULES_V1, regimeAllowsLongV1, simulateLongShortFlipV1 } from './long-short-flip-backtest-v1.mjs';
import { LONG_SHORT_FLIP_MAJORS_V2, resampleFlipCandlesV2 } from './long-short-flip-backtest-v2.mjs';

export const H4_MAJORS_FORWARD_CONTRACT_V1 = 'h4-majors-long-forward-paper/v1';
export const H4_MAJORS_RULE_ID = 'H4_MAJORS_LONG_V2';
/** Registration time of the rule (pre-registered; strict sample starts here). */
export const H4_MAJORS_REGISTERED_AT = Date.UTC(2026, 9, 18, 6, 0, 0);
export const H4_MAJORS_PROMOTION_V1 = Object.freeze({ minimumTrades: 30, minimumSymbols: 3 });

/** Pure: forward trades of the rule on every major (BTC drives the regime filter). */
export function h4MajorsForwardTradesV1({ datasets, nowMs }) {
  const bench = datasets.find((d) => d.symbol === 'BTCUSDT');
  const benchBars = bench ? resampleFlipCandlesV2(bench.candles, 4) : [];
  const regimeAllowed = bench ? regimeAllowsLongV1(benchBars, { ...LONG_SHORT_FLIP_RULES_V1, regimePeakBars: 6 }) : null;
  const trades = [];
  for (const d of datasets.filter((row) => LONG_SHORT_FLIP_MAJORS_V2.includes(row.symbol))) {
    const bars = resampleFlipCandlesV2(d.candles.filter((c) => c.timestamp <= nowMs), 4);
    const all = simulateLongShortFlipV1({
      candles: bars, fundingRates: d.fundingRates ?? [], regimeAllowed,
      variant: { id: 'H4_MAJORS_LONG', flip: false, regime: true }, holdoutGuard: false,
    });
    for (const t of all) {
      if (t.entryTime < FORWARD_PAPER_START_MS) continue;
      // The simulator closes an open position at the last bar ('END'): report it as OPEN.
      const open = t.reason === 'END';
      trades.push({ ...t, symbol: d.symbol, status: open ? 'OPEN' : 'CLOSED', strict: t.entryTime >= H4_MAJORS_REGISTERED_AT });
    }
  }
  return trades.sort((a, b) => a.entryTime - b.entryTime);
}

/** Pure: summaries and the promotion check. */
export function summarizeH4MajorsForwardV1(trades) {
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const strict = closed.filter((t) => t.strict);
  const forward = sampleSummaryV1(closed.map((t) => t.rMultiple));
  const strictSummary = sampleSummaryV1(strict.map((t) => t.rMultiple));
  const strictSymbols = new Set(strict.map((t) => t.symbol)).size;
  const rule = H4_MAJORS_PROMOTION_V1;
  const promotionEligible = strictSummary.n >= rule.minimumTrades && strictSummary.lower95 != null && strictSummary.lower95 > 0
    && strictSymbols >= rule.minimumSymbols;
  return {
    forward, strict: strictSummary, strictSymbols,
    open: trades.filter((t) => t.status === 'OPEN').length,
    promotionEligible,
    promotionGap: {
      tradesNeeded: Math.max(0, rule.minimumTrades - strictSummary.n),
      symbolsNeeded: Math.max(0, rule.minimumSymbols - strictSymbols),
      lowerBoundPositive: strictSummary.lower95 != null && strictSummary.lower95 > 0,
    },
  };
}

const num = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : Number(v).toFixed(d));

export function formatH4MajorsForwardKoV1(result) {
  const s = result.summary;
  const lines = [
    '4시간봉 대형 코인 롱 · 실시간 모의장부 (연구 전용, 주문 없음)',
    `대상: ${result.symbols.join(', ')} · 미사용 구간 시작 ${new Date(FORWARD_PAPER_START_MS).toISOString().slice(0, 10)} · 등록 ${new Date(H4_MAJORS_REGISTERED_AT).toISOString().slice(0, 10)}`,
    '',
    `미사용 구간 전체: 청산 ${s.forward.n}건 · 평균 ${num(s.forward.mean)}R · 합계 ${num(s.forward.total)}R · 승률 ${s.forward.winRate == null ? '-' : `${(s.forward.winRate * 100).toFixed(0)}%`}`,
    `등록 이후(엄격 표본): 청산 ${s.strict.n}건 · 평균 ${num(s.strict.mean)}R · 95% 하한 ${num(s.strict.lower95)}R · 종목 ${s.strictSymbols}개 · 보유 중 ${s.open}건`,
    s.promotionEligible
      ? '판정: 승격 조건 충족 (30건 · 하한>0 · 3종목) — 사장님 검토 후 다음 단계'
      : `판정: 아직 표본 수집 중 (거래 ${s.promotionGap.tradesNeeded}건 · 종목 ${s.promotionGap.symbolsNeeded}개 더 필요, 하한 ${s.promotionGap.lowerBoundPositive ? '통과' : '아직 0 이하'})`,
  ];
  if (result.trades.length) {
    lines.push('', '최근 거래:');
    for (const t of result.trades.slice(-8)) {
      lines.push(`  ${new Date(t.entryTime).toISOString().slice(0, 16)} ${t.symbol.padEnd(9)} ${t.status === 'OPEN' ? '보유 중' : `${num(t.rMultiple)}R (${t.reason})`}${t.strict ? '' : ' · 등록 전'}`);
    }
  }
  return lines.join('\n');
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

export async function runH4MajorsForwardPaperV1({ stateRoot, now = new Date() }) {
  const dir = join(stateRoot, 'h4-majors-forward', 'candles');
  const datasets = [];
  for (const symbol of LONG_SHORT_FLIP_MAJORS_V2) {
    try {
      const cached = JSON.parse(await readFile(join(dir, `${symbol}.json`), 'utf8'));
      datasets.push({ symbol, candles: cached.candles ?? [], fundingRates: cached.fundingRates ?? [] });
    } catch { /* missing symbol: reported by the symbol list */ }
  }
  const trades = h4MajorsForwardTradesV1({ datasets, nowMs: now.getTime() });
  const result = {
    contract: H4_MAJORS_FORWARD_CONTRACT_V1, ruleId: H4_MAJORS_RULE_ID, observedAt: now.toISOString(),
    symbols: datasets.map((d) => d.symbol), trades, summary: summarizeH4MajorsForwardV1(trades),
    executionAuthority: 'NONE', realOrder: false,
  };
  await atomicJson(join(stateRoot, 'latest', 'h4-majors-long-forward-paper-v1.json'), result);
  return result;
}
