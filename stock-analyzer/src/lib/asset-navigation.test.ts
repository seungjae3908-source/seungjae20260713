import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AssetRouteNotResolved,
  resolveAssetDetailPath,
  resolveLegacyCryptoDetailPath,
} from './asset-navigation';

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

test('legacy crypto route resolves only explicit Upbit spot or Bitget USDT futures identities', () => {
  const spot = resolveLegacyCryptoDetailPath('krw-btc');
  const futures = resolveLegacyCryptoDetailPath('BTCUSDT');
  const ethFutures = resolveLegacyCryptoDetailPath('ethusdt');

  assert.match(spot, /coinMarket=spot/);
  assert.match(spot, /symbol=BTC/);
  assert.match(futures, /coinMarket=futures/);
  assert.match(futures, /symbol=BTCUSDT/);
  assert.match(ethFutures, /coinMarket=futures/);
  assert.match(ethFutures, /symbol=ETHUSDT/);
  assert.throws(() => resolveLegacyCryptoDetailPath('BTC'), AssetRouteNotResolved);
  assert.throws(() => resolveLegacyCryptoDetailPath('BTCUSD'), AssetRouteNotResolved);
  assert.throws(() => resolveLegacyCryptoDetailPath(''), AssetRouteNotResolved);
});

test('legacy stock and crypto routes converge on canonical stock-info resolvers', () => {
  const app = readFileSync(path.join(process.cwd(), 'stock-analyzer/src/App.tsx'), 'utf8');
  assert.match(app, /function LegacyStockDetailRedirect\(\)/);
  assert.match(app, /resolveAssetDetailPath\(\{ assetClass: 'KR_STOCK'/);
  assert.match(app, /resolveAssetDetailPath\(\{ assetClass: 'US_STOCK'/);
  assert.match(app, /<Route path="\/stock\/:ticker" component=\{LegacyStockDetailRedirect\} \/>/);
  assert.match(app, /resolveLegacyCryptoDetailPath/);
  assert.match(app, /<Route path="\/crypto\/:symbol" component=\{CryptoDetailRedirect\} \/>/);
  assert.doesNotMatch(app, /coinMarket=spot&symbol=/);
  assert.doesNotMatch(app, /<Route path="\/stock\/:ticker" component=\{DetailPage\} \/>/);
});
