import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  DEFAULT_US_MICROCAP_STRATEGIES,
  optimizeUsMicrocapStrategy,
  type UsMicrocapCandle,
} from '../services/us-microcap-backtest.service';

type CsvRow = Record<string, string>;

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() || null : null;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function cell(row: CsvRow, aliases: string[]): string {
  for (const alias of aliases) {
    const value = row[normalizeHeader(alias)];
    if (value != null && value !== '') return value;
  }
  return '';
}

function timestamp(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseCsv(content: string, fallbackSymbol: string): UsMicrocapCandle[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])) as CsvRow;
    return {
      symbol: (cell(row, ['symbol', 'ticker', 'code']) || fallbackSymbol).toUpperCase(),
      timestamp: timestamp(cell(row, ['timestamp', 'date', 'datetime', 'time'])),
      open: Number(cell(row, ['open'])),
      high: Number(cell(row, ['high'])),
      low: Number(cell(row, ['low'])),
      close: Number(cell(row, ['close', 'adjclose', 'adjustedclose'])),
      volume: Number(cell(row, ['volume', 'vol'])),
    };
  });
}

async function filesUnder(inputPath: string): Promise<string[]> {
  const metadata = await stat(inputPath);
  if (metadata.isFile()) return [inputPath];
  const entries = await readdir(inputPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(inputPath, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(target));
    else if (/\.(csv|json)$/i.test(entry.name)) files.push(target);
  }
  return files.sort();
}

async function loadCandles(inputPath: string): Promise<UsMicrocapCandle[]> {
  const files = await filesUnder(inputPath);
  const rows: UsMicrocapCandle[] = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    if (/\.json$/i.test(file)) {
      const parsed = JSON.parse(content) as unknown;
      const candles = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { candles?: unknown }).candles)
          ? (parsed as { candles: unknown[] }).candles
          : [];
      rows.push(...candles as UsMicrocapCandle[]);
    } else {
      rows.push(...parseCsv(content, path.basename(file, path.extname(file))));
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const inputPath = argument('--input') ?? process.env.US_MICROCAP_BACKTEST_INPUT?.trim();
  const outputPath = argument('--output')
    ?? process.env.US_MICROCAP_BACKTEST_OUTPUT?.trim()
    ?? path.resolve(process.cwd(), '../artifacts/us-microcap-backtest-report.json');

  if (!inputPath) {
    throw new Error('US_MICROCAP_BACKTEST_INPUT 또는 --input에 실제 CSV/JSON 파일이나 디렉터리를 지정해야 합니다.');
  }
  const candles = await loadCandles(path.resolve(inputPath));
  if (!candles.length) {
    throw new Error('실제 OHLCV 데이터를 읽지 못했습니다. 필요한 열: symbol/ticker, date/timestamp, open, high, low, close, volume');
  }
  const result = optimizeUsMicrocapStrategy(candles, DEFAULT_US_MICROCAP_STRATEGIES);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    mode: result.mode,
    orderSubmitted: result.orderSubmitted,
    selectedStrategy: result.selectedStrategy?.id ?? null,
    training: result.training && {
      trades: result.training.totalTrades,
      winRate: result.training.winRate,
      finalCapital: result.training.finalCapital,
      netPnl: result.training.netPnl,
      maximumDrawdownPercent: result.training.maximumDrawdownPercent,
    },
    validation: result.validation && {
      trades: result.validation.totalTrades,
      winRate: result.validation.winRate,
      finalCapital: result.validation.finalCapital,
      netPnl: result.validation.netPnl,
      maximumDrawdownPercent: result.validation.maximumDrawdownPercent,
    },
    test: result.test && {
      trades: result.test.totalTrades,
      winRate: result.test.winRate,
      finalCapital: result.test.finalCapital,
      netPnl: result.test.netPnl,
      maximumDrawdownPercent: result.test.maximumDrawdownPercent,
    },
    liveEligible: result.liveEligible,
    outputPath,
    warnings: result.warnings,
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '미국 급등주 백테스트를 완료하지 못했습니다.');
  process.exitCode = 2;
});
