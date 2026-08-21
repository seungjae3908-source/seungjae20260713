import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  buildCoinSpecialFeedItems,
  type CoinSpecialFeedRow,
} from '../../api-server/src/services/coin-special-feed.service';

const rows: CoinSpecialFeedRow[] = [
  { symbol: 'BTC', name: '비트코인', price: 100, changePercent: 2, tradingValue24h: 900, timestamp: 1_780_000_000_000 },
  { symbol: 'XRP', name: '리플', price: 3, changePercent: -8, tradingValue24h: 700, timestamp: 1_780_000_001_000 },
  { symbol: 'ETH', name: '이더리움', price: 50, changePercent: 5, tradingValue24h: 800, timestamp: 1_780_000_002_000 },
];

test('coin special feed ranks objective public 24h movement without inventing AI or recommendations', () => {
  const items = buildCoinSpecialFeedItems('spot', rows, 3, Date.UTC(2026, 7, 21, 9, 0, 0));

  expect(items.map((item) => item.ticker)).toEqual(['XRP', 'ETH', 'BTC']);
  expect(items[0]).toMatchObject({
    asset: 'coin',
    kind: 'signal',
    market: 'spot',
    currency: 'KRW',
    source: 'Upbit public ticker',
    tone: 'negative',
    timeframe: '24h',
  });
  expect(items[0].title).toContain('-8.00%');
  expect(items[0].summary).toContain('절대 등락률 순위');
  expect(items[0].summary).toContain('투자 추천이나 AI 판단이 아닙니다.');
  expect(items.every((item) => item.url === null)).toBe(true);
});

test('futures feed stays Bitget public-only and uses USDT evidence semantics', () => {
  const items = buildCoinSpecialFeedItems('futures', [
    { symbol: 'BTCUSDT', name: 'BTCUSDT', price: 100_000, changePercent: 1.25, tradingValue24h: 50_000_000, timestamp: 1_780_000_000_000 },
  ], 1, Date.UTC(2026, 7, 21, 9, 0, 0));

  expect(items[0]).toMatchObject({
    ticker: 'BTCUSDT',
    market: 'futures',
    currency: 'USDT',
    source: 'Bitget public ticker',
    tone: 'positive',
  });
});

test('route registration keeps spot and futures capability gates and never references private credentials', () => {
  const repositoryRoot = path.resolve(process.cwd(), '..');
  const indexSource = fs.readFileSync(path.join(repositoryRoot, 'api-server/src/routes/index.ts'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(repositoryRoot, 'api-server/src/services/coin-special-feed.service.ts'), 'utf8');

  expect(indexSource).toContain("? 'canAccessFutures'");
  expect(indexSource).toContain(": 'canAccessSpot';");
  expect(indexSource).toContain("router.use('/stocks/special-feed', coinSpecialFeedRouter);");
  expect(serviceSource).toContain('https://api.upbit.com');
  expect(serviceSource).toContain('https://api.bitget.com');
  expect(serviceSource).not.toMatch(/UPBIT_ACCESS_KEY|UPBIT_SECRET_KEY|BITGET_API_KEY|BITGET_SECRET_KEY|PASSPHRASE|Authorization/i);
});
