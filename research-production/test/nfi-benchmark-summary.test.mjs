import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../benchmarks/nfi-benchmark-summary.mjs', import.meta.url));

import { combineMonthsV1, formatNfiSummaryKoV1, summarizeFreqtradeResultV1 } from '../benchmarks/nfi-benchmark-summary.mjs';

const block = (profit, trades, wins) => ({ strategy: { NostalgiaForInfinityX8: {
  total_trades: trades, wins, losses: trades - wins, profit_total: profit, profit_mean: profit / trades,
  max_drawdown_account: 0.05, market_change: -0.1, backtest_start: '2025-01-01', backtest_end: '2025-02-01', pairlist: ['BTC/USDT'] } } });

test('freqtrade summary keeps only aggregate fields', () => {
  const s = summarizeFreqtradeResultV1(block(0.1, 10, 6), 'NostalgiaForInfinityX8');
  assert.equal(s.trades, 10);
  assert.equal(s.winRate, 0.6);
  assert.equal(s.profitTotal, 0.1);
  assert.equal(summarizeFreqtradeResultV1({}, 'X'), null);
});

test('months compound and report the worst month', () => {
  const t = combineMonthsV1([{ profitTotal: 0.1, trades: 10, wins: 6, maxDrawdownAccount: 0.05 }, { profitTotal: -0.1, trades: 10, wins: 4, maxDrawdownAccount: 0.12 }]);
  assert.ok(Math.abs(t.compoundedReturn - (-0.01)) < 1e-12);
  assert.equal(t.positiveMonths, 1);
  assert.equal(t.winRate, 0.5);
  assert.equal(t.worstMonth, -0.1);
  assert.equal(t.worstMonthlyDrawdown, 0.12);
});

test('CLI reads per-month artifact folders (json and zip) and writes Korean markdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'nfi-sum-'));
  const a = join(root, 'nfi-backtest-20250101-20250201'); mkdirSync(a);
  writeFileSync(join(a, 'backtest-result-2025.json'), JSON.stringify(block(0.05, 20, 12)));
  const b = join(root, 'nfi-backtest-20250201-20250301'); mkdirSync(b);
  writeFileSync(join(b, 'backtest-result-2025-02.json'), JSON.stringify(block(-0.02, 15, 7)));
  execFileSync('zip', ['-q', '-j', join(b, 'backtest-result-2025-02.zip'), join(b, 'backtest-result-2025-02.json')]);
  execFileSync('rm', [join(b, 'backtest-result-2025-02.json')]);
  mkdirSync(join(root, 'nfi-backtest-20250301-20250401'));
  const out = join(root, 's.json');
  execFileSync('node', [SCRIPT, root, '--commit', 'a'.repeat(40),
    '--strategy', 'NostalgiaForInfinityX8', '--exchange', 'kucoin', '--mode', 'spot', '--json', out]);
  const summary = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(summary.months.length, 2);
  assert.deepEqual(summary.missingMonths, ['20250301-20250401']);
  assert.equal(summary.executionAuthority, 'NONE');
  assert.match(formatNfiSummaryKoV1(summary), /합계\(월별 복리\)/);
});
