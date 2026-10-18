#!/usr/bin/env node
// Summarizes freqtrade backtest exports of the public NFI benchmark (one folder
// per month) into JSON and a Korean markdown table. Read-only; no network.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const NFI_SUMMARY_CONTRACT_V1 = 'nfi-public-benchmark-summary/v1';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Pure: pick the strategy block of a freqtrade result and keep only summary fields. */
export function summarizeFreqtradeResultV1(result, strategyName) {
  const block = result?.strategy?.[strategyName] ?? Object.values(result?.strategy ?? {})[0];
  if (!block || typeof block !== 'object') return null;
  const trades = finite(block.total_trades) ?? (Array.isArray(block.trades) ? block.trades.length : null);
  const wins = finite(block.wins);
  return {
    timerangeStart: block.backtest_start ?? null,
    timerangeEnd: block.backtest_end ?? null,
    trades,
    wins,
    losses: finite(block.losses),
    winRate: finite(block.winrate) ?? (trades && wins != null ? wins / trades : null),
    profitTotal: finite(block.profit_total),
    profitMean: finite(block.profit_mean),
    maxDrawdownAccount: finite(block.max_drawdown_account),
    marketChange: finite(block.market_change),
    pairs: Array.isArray(block.pairlist) ? block.pairlist.length : null,
  };
}

/** Pure: compound monthly results into one row of totals. */
export function combineMonthsV1(months) {
  const valid = months.filter((m) => Number.isFinite(m.profitTotal));
  const compounded = valid.reduce((equity, m) => equity * (1 + m.profitTotal), 1) - 1;
  const trades = valid.reduce((sum, m) => sum + (m.trades ?? 0), 0);
  const wins = valid.reduce((sum, m) => sum + (m.wins ?? 0), 0);
  return {
    months: valid.length,
    positiveMonths: valid.filter((m) => m.profitTotal > 0).length,
    compoundedReturn: valid.length ? compounded : null,
    trades,
    winRate: trades ? wins / trades : null,
    worstMonth: valid.length ? Math.min(...valid.map((m) => m.profitTotal)) : null,
    worstMonthlyDrawdown: valid.length ? Math.max(...valid.map((m) => m.maxDrawdownAccount ?? 0)) : null,
  };
}

function loadResult(path) {
  if (path.endsWith('.json')) return JSON.parse(readFileSync(path, 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'nfi-'));
  execFileSync('unzip', ['-q', '-o', path, '-d', dir]);
  const json = walk(dir).find((file) => file.endsWith('.json') && !file.includes('_config') && !file.includes('meta'));
  return json ? JSON.parse(readFileSync(json, 'utf8')) : null;
}

const pct = (value) => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%` : '-');

export function formatNfiSummaryKoV1(summary) {
  const lines = [
    `## 공개 전략 기준선: ${summary.strategy} (${summary.exchange} ${summary.mode}, 커밋 ${summary.commit.slice(0, 7)})`,
    '',
    '| 월 | 거래 | 승률 | 수익 | 최대낙폭 | 시장 변화 |',
    '|---|---|---|---|---|---|',
    ...summary.months.map((m) => `| ${m.month} | ${m.trades ?? '-'} | ${pct(m.winRate)} | ${pct(m.profitTotal)} | ${pct(m.maxDrawdownAccount)} | ${pct(m.marketChange)} |`),
    '',
    `**합계(월별 복리):** ${pct(summary.total.compoundedReturn)} · 플러스 월 ${summary.total.positiveMonths}/${summary.total.months} · 거래 ${summary.total.trades} · 승률 ${pct(summary.total.winRate)} · 최악의 달 ${pct(summary.total.worstMonth)}`,
    '',
    `빠진 달: ${summary.missingMonths.length ? summary.missingMonths.join(', ') : '없음'}`,
    '',
    '공개 데이터·freqtrade 기본 비용으로 계산한 연구용 기준선입니다. 우리 연구 결과는 이 숫자를 넘어야 의미가 있습니다. 주문 권한 없음.',
  ];
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = { dir: argv[2] };
  for (let i = 3; i < argv.length; i += 2) out[argv[i].replace(/^--/u, '')] = argv[i + 1];
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  if (!args.dir || !existsSync(args.dir)) throw new Error('NFI_SUMMARY_RESULTS_DIR_REQUIRED');
  const months = [];
  const missing = [];
  for (const folder of readdirSync(args.dir).filter((name) => name.startsWith('nfi-backtest-')).sort()) {
    const month = folder.replace('nfi-backtest-', '');
    const files = walk(join(args.dir, folder)).filter((file) => /backtest-result.*\.(zip|json)$/u.test(file) && !file.includes('meta') && !file.endsWith('.last_result.json'));
    const summary = files.length ? summarizeFreqtradeResultV1(loadResult(files.sort().at(-1)), args.strategy) : null;
    if (summary) months.push({ month, ...summary });
    else missing.push(month);
  }
  const summary = {
    contract: NFI_SUMMARY_CONTRACT_V1,
    strategy: args.strategy, commit: args.commit, exchange: args.exchange, mode: args.mode,
    generatedAt: new Date().toISOString(),
    months, missingMonths: missing, total: combineMonthsV1(months),
    executionAuthority: 'NONE', liveTrading: false,
  };
  if (args.json) writeFileSync(args.json, `${JSON.stringify(summary, null, 2)}\n`);
  if (args.markdown) writeFileSync(args.markdown, `${formatNfiSummaryKoV1(summary)}\n`);
  process.stdout.write(`${formatNfiSummaryKoV1(summary)}\n`);
}
