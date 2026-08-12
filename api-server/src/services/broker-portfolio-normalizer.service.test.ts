import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrokerPortfolioSnapshot } from './broker-portfolio-normalizer.service';

test('normalizes four providers without inventing cross-currency conversion or double-counting futures notional', () => {
  const portfolio = normalizeBrokerPortfolioSnapshot({
    checkedAt: '2026-08-12T00:00:00.000Z',
    providers: {
      toss: {
        configured: true, connected: true, connectionState: 'CONNECTED_READ_ONLY',
        balances: [{ accountId: '7', currency: 'KRW', available: 300_000, locked: null, equity: null }],
        holdings: [{
          accountId: '7', market: 'KR_STOCK', symbol: '005930', name: '삼성전자', currency: 'KRW',
          quantity: 10, averagePrice: 100_000, currentPrice: 120_000,
          evaluationAmount: 1_200_000, profitLoss: 200_000, profitRate: 20,
        }],
      },
      kiwoom: {
        configured: true, connected: true, accountMasked: '12******34',
        kr: {
          estimatedAssets: 1_000_000, totalEvaluationAmount: 750_000, totalProfitLoss: 50_000,
          holdings: [{ symbol: '000660', name: 'SK하이닉스', quantity: 5, evaluationAmount: 750_000, currency: 'KRW' }],
        },
        us: { holdings: [] },
      },
      upbit: {
        configured: true, connected: true,
        assets: [
          { currency: 'KRW', balance: 500_000, locked: 0, unitCurrency: 'KRW' },
          { currency: 'BTC', balance: 0.01, locked: 0, averageBuyPrice: 100_000_000, unitCurrency: 'KRW' },
        ],
      },
      bitget: {
        configured: true, connected: true,
        accounts: [{ marginCoin: 'USDT', available: 900, locked: 10, accountEquity: 1_000, unrealizedPL: 25 }],
        positions: [{ symbol: 'BTCUSDT', marginCoin: 'USDT', side: 'long', total: 0.002, markPrice: 100_000, leverage: 2 }],
      },
    },
  });

  assert.equal(portfolio.baseCurrency, null);
  assert.equal(portfolio.conversionApplied, false);
  const krw = portfolio.totalsByCurrency.find((item) => item.currency === 'KRW');
  assert.equal(krw?.totalAssets, 3_000_000);
  assert.equal(krw?.cashAvailable, 1_050_000);
  assert.equal(krw?.holdingsMarketValue, 1_950_000);
  assert.equal(krw?.pricingComplete, false);
  assert.deepEqual(krw?.providers, ['kiwoom', 'toss', 'upbit']);
  const usdt = portfolio.totalsByCurrency.find((item) => item.currency === 'USDT');
  assert.equal(usdt?.totalAssets, 1_000);
  assert.equal(usdt?.derivativesNotional, 200);
  assert.equal(portfolio.holdings.find((item) => item.symbol === '005930')?.sourceProvider, 'toss');
  assert.equal(portfolio.holdings.find((item) => item.symbol === 'BTC')?.valuationState, 'UNPRICED');
  assert.equal(portfolio.positions[0]?.sourceProvider, 'bitget');
});

test('preserves disconnected and access-waiting states without fake values', () => {
  const portfolio = normalizeBrokerPortfolioSnapshot({
    checkedAt: '2026-08-12T01:00:00.000Z',
    providers: {
      toss: { configured: false, connected: false, connectionState: 'WAITING_FOR_TOSS_API_ACCESS', error: 'TOSS_API_ACCESS_REQUIRED' },
      kiwoom: { configured: false, connected: false },
      upbit: { configured: false, connected: false },
      bitget: { configured: false, connected: false },
    },
  });
  assert.deepEqual(portfolio.totalsByCurrency, []);
  assert.deepEqual(portfolio.holdings, []);
  assert.deepEqual(portfolio.incompleteProviders, ['toss', 'kiwoom', 'upbit', 'bitget']);
  const toss = portfolio.providers.find((item) => item.provider === 'toss');
  assert.equal(toss?.connectionState, 'WAITING_FOR_TOSS_API_ACCESS');
  assert.equal(toss?.errorCode, 'TOSS_API_ACCESS_REQUIRED');
});
