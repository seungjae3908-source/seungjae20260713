import test from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../src/server.mjs';

function addressUrl() {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SERVER_ADDRESS_UNAVAILABLE');
  return `http://127.0.0.1:${address.port}`;
}

async function post(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/v1/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function book(ts, askSize) {
  return {
    ts,
    bids: [[100, 10], [99.9, 8], [99.8, 7], [99.7, 6], [99.6, 5], [99.5, 4]],
    asks: [[100.1, askSize], [100.2, 8], [100.3, 7], [100.4, 6], [100.5, 5], [100.6, 4]],
  };
}

async function withServer(run) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run(addressUrl());
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('stale remembered wall cannot contribute legacy liquidity-withdrawal score', async () => {
  await withServer(async (baseUrl) => {
    const start = 1_800_000_000_000;
    await post(baseUrl, {
      now: start,
      asOf: start,
      market: 'CRYPTO_SPOT',
      symbol: 'KRW-FAKEWALL-STALE',
      orderBook: book(start, 100),
      trades: [{ side: 'buy', price: 100.05, size: 1, ts: start - 100 }],
    });

    const later = start + 60_000;
    const payload = await post(baseUrl, {
      now: later,
      asOf: later,
      market: 'CRYPTO_SPOT',
      symbol: 'KRW-FAKEWALL-STALE',
      orderBook: book(later, 5),
      trades: [{ side: 'buy', price: 100.05, size: 1, ts: later - 100 }],
    });

    assert.equal(payload.result.microstructure.liquidityWithdrawal.score, 0);
    assert.equal(payload.result.microstructure.spoofCandidate.state, 'NO_CANDIDATE');
    assert.ok(payload.result.warnings.includes('PREVIOUS_MICROSTRUCTURE_SNAPSHOT_REJECTED'));
    assert.equal(payload.result.autoTrading.orderAllowed, false);
    assert.equal(payload.result.safety.executionAuthority, 'NONE');
  });
});

test('out-of-order remembered snapshot cannot contribute legacy wall or OFI comparison', async () => {
  await withServer(async (baseUrl) => {
    const start = 1_800_100_000_000;
    await post(baseUrl, {
      now: start + 2_000,
      asOf: start + 2_000,
      market: 'CRYPTO_SPOT',
      symbol: 'KRW-FAKEWALL-ORDER',
      orderBook: book(start + 2_000, 100),
      trades: [{ side: 'buy', price: 100.05, size: 1, ts: start + 1_900 }],
    });

    const payload = await post(baseUrl, {
      now: start + 1_000,
      asOf: start + 1_000,
      market: 'CRYPTO_SPOT',
      symbol: 'KRW-FAKEWALL-ORDER',
      orderBook: book(start + 1_000, 5),
      trades: [{ side: 'sell', price: 100.05, size: 1, ts: start + 900 }],
    });

    assert.equal(payload.result.microstructure.liquidityWithdrawal.score, 0);
    assert.equal(payload.result.microstructure.ofi, 0);
    assert.ok(payload.result.warnings.includes('PREVIOUS_MICROSTRUCTURE_SNAPSHOT_REJECTED'));
    assert.equal(payload.result.autoTrading.orderAllowed, false);
  });
});
