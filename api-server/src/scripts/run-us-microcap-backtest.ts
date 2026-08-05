import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { MarketDataService } from '../services/market-data.service';
import { ScannerUniverseService } from '../services/scanner-universe.service';
import {
  DEFAULT_US_MICROCAP_STRATEGIES,
  optimizeUsMicrocapStrategy,
  type UsMicrocapCandle,
} from '../services/us-microcap-backtest.service';

type CsvRow = Record<string, string>;
type ProviderLoadResult = {
  candles: UsMicrocapCandle[];
  requestedSymbols: number;
  loadedSymbols: number;
  failedSymbols: number;
  universeSource: string;
  universeStale: boolean;
};

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() || null : null;
}

function boundedInteger(value: string | undefined | null, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
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

function timestamp(value: unknown): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  const parsed = Date.parse(String(value ?? ''));
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
    if (entry.isDirectory()) {
      const nested = await filesUnder(target);
      for (const file of nested) files.push(file);
    } else if (/\.(csv|json)$/i.test(entry.name)) {
      files.push(target);
    }
  }
  return files.sort();
}

async function loadFileCandles(inputPath: string): Promise<UsMicrocapCandle[]> {
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
      for (const candle of candles) rows.push(candle as UsMicrocapCandle);
    } else {
      const candles = parseCsv(content, path.basename(file, path.extname(file)));
      for (const candle of candles) rows.push(candle);
    }
  }
  return rows;
}

function evenlySample<T>(items: readonly T[], limit: number): T[] {
  if (limit >= items.length) return [...items];
  if (limit <= 1) return items.length ? [items[0]] : [];
  const sampled: T[] = [];
  const step = (items.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) sampled.push(items[Math.round(index * step)]);
  return sampled;
}

async function loadProviderCandles(symbolLimit: number, concurrency: number): Promise<ProviderLoadResult> {
  const universe = await ScannerUniverseService.get('US');
  const eligible = universe.entries.filter((entry) =>
    entry.listingStatus === 'LISTED'
    && (entry.assetType === 'STOCK' || entry.assetType === 'ADR'),
  );
  const selected = evenlySample(eligible, symbolLimit);
  const candles: UsMicrocapCandle[] = [];
  let nextIndex = 0;
  let loadedSymbols = 0;
  let failedSymbols = 0;

  async function worker(): Promise<void> {
    while (nextIndex < selected.length) {
      const entry = selected[nextIndex];
      nextIndex += 1;
      try {
        const rows = await MarketDataService.getCandles(entry.ticker, '1D');
        const normalized = rows.map((candle) => ({
          symbol: entry.ticker,
          timestamp: timestamp(candle.time),
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
          volume: Number(candle.volume),
        }));
        if (normalized.length >= 100) {
          for (const candle of normalized) candles.push(candle);
          loadedSymbols += 1;
        } else {
          failedSymbols += 1;
        }
      } catch {
        failedSymbols += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));
  return {
    candles,
    requestedSymbols: selected.length,
    loadedSymbols,
    failedSymbols,
    universeSource: universe.source,
    universeStale: universe.stale,
  };
}

async function main(): Promise<void> {
  const inputPath = argument('--input') ?? process.env.US_MICROCAP_BACKTEST_INPUT?.trim();
  const outputPath = argument('--output')
    ?? process.env.US_MICROCAP_BACKTEST_OUTPUT?.trim()
    ?? path.resolve(process.cwd(), '../artifacts/us-microcap-backtest-report.json');
  const symbolLimit = boundedInteger(
    argument('--symbols') ?? process.env.US_MICROCAP_BACKTEST_SYMBOL_LIMIT,
    500,
    50,
    5_000,
  );
  const concurrency = boundedInteger(
    argument('--concurrency') ?? process.env.US_MICROCAP_BACKTEST_CONCURRENCY,
    4,
    1,
    8,
  );

  const provider = inputPath ? null : await loadProviderCandles(symbolLimit, concurrency);
  const candles = inputPath
    ? await loadFileCandles(path.resolve(inputPath))
    : provider?.candles ?? [];
  if (!candles.length) {
    throw new Error(inputPath
      ? '실제 OHLCV 데이터를 읽지 못했습니다. 필요한 열: symbol/ticker, date/timestamp, open, high, low, close, volume'
      : '앱의 미국 종목 마스터 또는 과거 일봉 공급자에서 백테스트 데이터를 확보하지 못했습니다.');
  }

  const result = optimizeUsMicrocapStrategy(candles, DEFAULT_US_MICROCAP_STRATEGIES);
  if (provider) {
    result.warnings.push(
      `미국 종목 마스터 ${provider.requestedSymbols}개 요청 중 ${provider.loadedSymbols}개를 검증했고 ${provider.failedSymbols}개는 제외했습니다.`,
    );
    if (provider.universeStale) result.warnings.push(`종목 마스터가 ${provider.universeSource} 상태여서 결과를 실전 후보로 사용할 수 없습니다.`);
    result.warnings.push('시가총액·유통주식수 과거 데이터가 없어 현재 자동 수집은 실제 microcap 판정이 아닌 저가 급등주 OHLCV 검증입니다.');
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    mode: result.mode,
    orderSubmitted: result.orderSubmitted,
    dataSource: inputPath ? 'file' : provider?.universeSource ?? 'provider-unavailable',
    requestedSymbols: provider?.requestedSymbols ?? null,
    loadedSymbols: provider?.loadedSymbols ?? null,
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
