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

test('sidecar retains bounded pre-withdrawal history and emits observe-only spoof candidate', async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = addressUrl();
  const start = 1_800_000_000_000;
  try {
    for (let index = 0; index < 3; index += 1) {
      const asOf = start + index * 1_000;
      const payload = await post(baseUrl, {
        now: asOf,
        asOf,
        market: 'CRYPTO_SPOT',
        symbol: 'KRW-FAKEWALL-HISTORY',
        orderBook: book(asOf, 100),
        trades: [{ side: 'buy', price: 100.05, size: 1, ts: asOf - 100 }],
      });
      assert.equal(payload.ok, true);
    }

    const asOf = start + 3_000;
    const payload = await post(baseUrl, {
      now: asOf,
      asOf,
      market: 'CRYPTO_SPOT',
      symbol: 'KRW-FAKEWALL-HISTORY',
      orderBook: book(asOf, 5),
      trades: [{ side: 'buy', price: 100.05, size: 1, ts: asOf - 100 }],
    });

    const candidate = payload.result.microstructure.spoofCandidate;
    assert.equal(candidate.state, 'CANDIDATE');
    assert.equal(candidate.direction, 'BULLISH_SUPPORT');
    assert.equal(candidate.mode, 'OBSERVE_ONLY');
    assert.equal(candidate.parentGateImpact, 'NONE');
    assert.equal(candidate.orderAllowed, false);
    assert.equal(candidate.executionAuthority, 'NONE');
    assert.ok(candidate.evidence.persistenceSnapshots >= 2);
    assert.ok(payload.result.microstructure.liquidityWithdrawal.score > 0);
    assert.equal(payload.result.safety.executionAuthority, 'NONE');
    assert.equal(payload.result.autoTrading.orderAllowed, false);

    const contracts = await fetch(`${baseUrl}/v1/contracts`).then((response) => response.json());
    assert.equal(contracts.spoofCandidate.mode, 'OBSERVE_ONLY');
    assert.equal(contracts.spoofCandidate.scannerHardBlockAllowed, false);
    assert.equal(contracts.spoofCandidate.parentGateImpact, 'NONE');
    assert.equal(contracts.spoofCandidate.orderAllowed, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
