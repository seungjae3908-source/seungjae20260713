import test from 'node:test';
import assert from 'node:assert/strict';
import { passesMinimalHardGate } from './scanner-adaptive-threshold-arena.service';

test('soft score does not become a hard gate', () => {
  const candidate = {
    id: 'sample',
    market: 'KR',
    strategy: 'SCALPING',
    regime: 'RANGE',
    softScore: 1,
    hardGate: {
      dataQualityPassed: true,
      liquidityPassed: true,
      safetyPassed: true,
    },
  };
  assert.equal(passesMinimalHardGate(candidate), true);
});
