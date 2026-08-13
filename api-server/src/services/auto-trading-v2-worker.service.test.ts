import test from 'node:test';
import assert from 'node:assert/strict';
import { autoTradingV2WorkerHealth, runAutoTradingV2WorkerCycle } from './auto-trading-v2-worker.service';

test('worker can be hard-disabled without touching DB or exchange APIs', async () => {
  const previous = process.env.AUTO_TRADING_V2_WORKER_ENABLED;
  process.env.AUTO_TRADING_V2_WORKER_ENABLED = 'false';
  try {
    const health = autoTradingV2WorkerHealth();
    assert.equal(health.enabled, false);
    assert.equal(health.ready, false);
    assert.equal(health.reason, 'AUTO_TRADING_V2_WORKER_DISABLED');
    assert.equal(health.realOrderCount, 0);
    assert.equal(health.realCancelCount, 0);
    assert.equal(health.privateTradingApiCount, 0);
    const cycle = await runAutoTradingV2WorkerCycle(new Date('2026-08-13T02:00:00.000Z'));
    assert.equal(cycle.ok, false);
    assert.equal(cycle.users.length, 0);
  } finally {
    if (previous == null) delete process.env.AUTO_TRADING_V2_WORKER_ENABLED;
    else process.env.AUTO_TRADING_V2_WORKER_ENABLED = previous;
  }
});
