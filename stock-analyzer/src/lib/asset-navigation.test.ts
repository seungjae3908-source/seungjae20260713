import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetRouteNotResolved, resolveAssetDetailPath } from './asset-navigation';

test('canonical asset resolver routes KR and US assets to stock detail', () => {
  const samsung = resolveAssetDetailPath({ assetClass: 'KR_STOCK', market: 'KR', symbol: '005930', canonicalSymbol: '005930' });
  const aapl = resolveAssetDetailPath({ assetClass: 'US_STOCK', market: 'US', symbol: 'AAPL', canonicalSymbol: 'AAPL' });
  const krEtf = resolveAssetDetailPath({ assetClass: 'KR_ETF', market: 'KR', symbol: '069500', canonicalSymbol: '069500' });
  assert.match(samsung, /^\/stock-info\?/);
  assert.match(samsung, /market=KR/);
  assert.match(samsung, /ticker=005930/);
  assert.match(aapl, /market=US/);
  assert.match(aapl, /ticker=AAPL/);
  assert.match(krEtf, /ticker=069500/);
});

test('canonical asset resolver separates Upbit spot and Bitget futures', () => {
  const spot = resolveAssetDetailPath({ assetClass: 'CRYPTO_SPOT', market: 'UPBIT', symbol: 'KRW-BTC', canonicalSymbol: 'BTC' });
  const futures = resolveAssetDetailPath({ assetClass: 'CRYPTO_FUTURES', market: 'BITGET', symbol: 'BTCUSDT', canonicalSymbol: 'BTCUSDT' });
  assert.match(spot, /coinMarket=spot/);
  assert.match(spot, /symbol=BTC/);
  assert.match(futures, /coinMarket=futures/);
  assert.match(futures, /symbol=BTCUSDT/);
});

test('canonical asset resolver fails closed instead of guessing a detail route', () => {
  assert.throws(
    () => resolveAssetDetailPath({ assetClass: 'CRYPTO_FUTURES', market: 'UPBIT', symbol: 'BTCUSDT', canonicalSymbol: 'BTCUSDT' }),
    AssetRouteNotResolved,
  );
  assert.throws(
    () => resolveAssetDetailPath({ assetClass: 'INDEX', market: 'INDEX', symbol: 'KOSPI', canonicalSymbol: 'KOSPI' }),
    AssetRouteNotResolved,
  );
});
