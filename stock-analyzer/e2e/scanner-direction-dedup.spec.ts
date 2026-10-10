import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { uniqueScannerDisplayCards } from '../src/lib/scanner-display-cards';

type Card = {
  assetClass: string;
  symbol: string;
  name: string;
  signalId: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  action: 'LONG' | 'SHORT' | 'BUY' | 'NONE';
  signalGrade: 'B';
};
const card = (assetClass: string, symbol: string, direction: Card['direction'], id: string): Card => ({
  assetClass, symbol, name: symbol, signalId: id, direction,
  action: direction === 'LONG' && assetClass !== 'coin_futures' ? 'BUY'
    : direction === 'NEUTRAL' ? 'NONE' : direction,
  signalGrade: 'B',
});

test('futures LONG and SHORT for the same symbol both survive display normalization', () => {
  const long = card('coin_futures', 'BTCUSDT', 'LONG', 'btc-long');
  const short = card('coin_futures', 'BTCUSDT', 'SHORT', 'btc-short');
  const duplicateLong = card('coin_futures', 'btcusdt', 'LONG', 'btc-long-duplicate');
  const actual = uniqueScannerDisplayCards([long, short, duplicateLong]);
  expect(actual.map((row) => row.signalId)).toEqual(['btc-long', 'btc-short']);
  expect(actual.map((row) => row.direction)).toEqual(['LONG', 'SHORT']);
  // The UI's LONG/SHORT filters must now have a real result for each side.
  expect(actual.filter((row) => row.direction === 'LONG')).toHaveLength(1);
  expect(actual.filter((row) => row.direction === 'SHORT')).toHaveLength(1);
  expect(actual.every((row) => row.signalGrade === 'B')).toBe(true);
});

test('stocks and spot still suppress duplicate same-symbol results', () => {
  for (const assetClass of ['stock', 'coin_spot']) {
    const a = card(assetClass, 'BTC', 'LONG', 'first');
    const b = card(assetClass, 'btc', 'SHORT', 'second');
    expect(uniqueScannerDisplayCards([a, b])).toEqual([a]);
  }
});

test('missing evidence and duplicate IDs fail closed without creating approval targets', () => {
  const first = card('coin_futures', 'ETHUSDT', 'LONG', 'shared-id');
  const badId = card('coin_futures', 'ETHUSDT', 'SHORT', 'shared-id');
  const missing = { ...card('coin_futures', 'XRPUSDT', 'SHORT', 'missing'), signalId: '' };
  const invalidName = { ...card('coin_futures', 'SOLUSDT', 'SHORT', 'bad-name'), name: '' };
  expect(uniqueScannerDisplayCards([first, badId, missing, invalidName])).toEqual([first]);
});

test('scanner page uses direction-preserving normalization before filters and selection', () => {
  const source = readFileSync(new URL('../src/pages/signal-scanner.tsx', import.meta.url), 'utf8');
  expect(source).toContain('uniqueScannerDisplayCards(data?.cards ?? [])');
  expect(source).toContain("normalizedCards.filter((card) => card.direction === 'LONG')");
  expect(source).toContain("normalizedCards.filter((card) => card.direction === 'SHORT')");
  expect(source).toContain('card.signalId === selectedSignalId');
});

test('a futures alert reveals a candidate hidden by the opposite-direction tab', () => {
  const source = readFileSync(new URL('../src/pages/signal-scanner.tsx', import.meta.url), 'utf8');
  const alertSection = source.slice(source.indexOf('data.alerts.map((alert) => ('));
  expect(alertSection).toContain("if (view === 'FUTURES') setFuturesDirectionFilter('ALL'); selectSignal(card);");
  expect(source).toContain("visibleCards.find((card) => card.signalId === selectedSignalId)");
});

test('non-actionable futures signals still retain their factual LONG/SHORT direction', () => {
  const long = { ...card('coin_futures', 'ETHUSDT', 'LONG', 'eth-long-watch'), action: 'NONE' as const };
  const short = { ...card('coin_futures', 'ETHUSDT', 'SHORT', 'eth-short-watch'), action: 'NONE' as const };
  const visible = uniqueScannerDisplayCards([long, short]);
  expect(visible.filter((row) => row.direction === 'LONG')).toEqual([long]);
  expect(visible.filter((row) => row.direction === 'SHORT')).toEqual([short]);
  expect(visible.every((row) => row.action === 'NONE')).toBe(true);
});
