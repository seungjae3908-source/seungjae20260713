import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSignalIntelligenceOverlay } from '../src/signal-overlay.mjs';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('overlay preserves stock candidates and enriches crypto candidates without granting order authority', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (String(url) === 'http://127.0.0.1:8790/v1/signals') {
      return response({
        ok: true,
        serviceSha: 'signal-sha',
        snapshot: {
          generatedAt: '2026-08-17T00:00:00.000Z',
          lists: {
            krBuy: [{ market: 'KR_STOCK', symbol: '005930', direction: 'BUY' }],
            usBuy: [{ market: 'US_STOCK', symbol: 'AAPL', direction: 'BUY' }],
            spotBuy: [{ market: 'CRYPTO_SPOT', symbol: 'KRW-BTC', direction: 'BUY' }],
            futuresLong: [{ market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', direction: 'LONG' }],
            futuresShort: [],
          },
        },
      });
    }
    if (String(url).includes('/v1/public/crypto/spot/KRW-BTC')) {
      return response({
        ok: true,
        serviceSha: 'intelligence-sha',
        provenance: { provider: 'UPBIT_PUBLIC' },
        result: {
          scanner: { mode: 'SOFT_INTELLIGENCE_LAYER', scoreAdjustment: 4 },
          autoTrading: { status: 'PAPER_ONLY', orderAllowed: false, executionAuthority: 'NONE' },
        },
      });
    }
    if (String(url).includes('/v1/public/crypto/futures/BTCUSDT')) {
      return response({
        ok: true,
        serviceSha: 'intelligence-sha',
        provenance: { provider: 'BITGET_PUBLIC' },
        result: {
          scanner: { mode: 'SOFT_INTELLIGENCE_LAYER', scoreAdjustment: -3 },
          autoTrading: { status: 'BLOCKED_RISK', orderAllowed: false, executionAuthority: 'NONE' },
        },
      });
    }
    throw new Error(`UNEXPECTED_URL:${url}`);
  };

  const overlay = await buildSignalIntelligenceOverlay({ fetchImpl: fakeFetch });
  assert.equal(overlay.ok, true);
  assert.equal(overlay.contract, 'market-intelligence-signal-overlay/v1');
  assert.equal(overlay.stats.totalCandidates, 4);
  assert.equal(overlay.stats.intelligenceReady, 2);
  assert.equal(overlay.stats.intelligenceUnavailable, 2);
  assert.equal(overlay.safety.candidateDeletionAllowed, false);
  assert.equal(overlay.safety.realOrderAllowed, false);

  const kr = overlay.lists.krBuy[0];
  assert.equal(kr.symbol, '005930');
  assert.equal(kr.marketIntelligence.status, 'NOT_AVAILABLE');
  assert.equal(kr.marketIntelligence.scanner.action, 'PRESERVE_CANDIDATE');
  assert.equal(kr.marketIntelligence.autoTrading.orderAllowed, false);

  const spot = overlay.lists.spotBuy[0];
  assert.equal(spot.marketIntelligence.status, 'READY');
  assert.equal(spot.marketIntelligence.result.scanner.scoreAdjustment, 4);
  assert.equal(spot.marketIntelligence.result.autoTrading.orderAllowed, false);

  const futures = overlay.lists.futuresLong[0];
  assert.equal(futures.marketIntelligence.status, 'READY');
  assert.equal(futures.marketIntelligence.result.autoTrading.status, 'BLOCKED_RISK');
  assert.equal(futures.marketIntelligence.result.autoTrading.orderAllowed, false);
  assert.equal(calls.length, 3);
});

test('overlay fail-soft preserves crypto candidate when intelligence provider is unavailable', async () => {
  const fakeFetch = async (url) => {
    if (String(url).endsWith('/v1/signals')) {
      return response({
        ok: true,
        serviceSha: 'signal-sha',
        snapshot: {
          generatedAt: '2026-08-17T00:00:00.000Z',
          lists: {
            krBuy: [], usBuy: [], futuresLong: [], futuresShort: [],
            spotBuy: [{ market: 'CRYPTO_SPOT', symbol: 'KRW-ETH', direction: 'BUY' }],
          },
        },
      });
    }
    return response({ ok: false }, 503);
  };

  const overlay = await buildSignalIntelligenceOverlay({ fetchImpl: fakeFetch, timeoutMs: 500 });
  const row = overlay.lists.spotBuy[0];
  assert.equal(row.symbol, 'KRW-ETH');
  assert.equal(row.marketIntelligence.status, 'NOT_AVAILABLE');
  assert.match(row.marketIntelligence.reason, /SIGNAL_OVERLAY_HTTP_503/);
  assert.equal(row.marketIntelligence.scanner.action, 'PRESERVE_CANDIDATE');
  assert.equal(row.marketIntelligence.autoTrading.orderAllowed, false);
});

test('overlay rejects non-loopback upstream configuration', async () => {
  await assert.rejects(
    () => buildSignalIntelligenceOverlay({ signalBaseUrl: 'https://example.com', fetchImpl: async () => response({}) }),
    /SIGNAL_OVERLAY_LOOPBACK_ONLY/,
  );
});
