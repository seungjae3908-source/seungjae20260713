import test from 'node:test';
import assert from 'node:assert/strict';
import { trendPilotSelectionAuditV1 } from '../src/trend-pilot-selection-audit-v1.mjs';

function seeded(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const noise = (rand) => (rand() + rand() + rand() - 1.5) * 0.04;
const series = (n, edge, seed) => { const rand = seeded(seed); return Array.from({ length: n }, () => edge + noise(rand)); };

test('a clearly skilled variant among luck-only variants is supported; luck-only variants are not', () => {
  const skilled = trendPilotSelectionAuditV1([
    { variantId: 'A', returns: series(200, 0.02, 1) },
    { variantId: 'B', returns: series(200, 0.0, 2) },
    { variantId: 'C', returns: series(200, 0.0, 3) },
    { variantId: 'D', returns: series(200, 0.0, 4) },
    { variantId: 'E', returns: series(200, 0.0, 5) },
  ]);
  assert.equal(skilled.best.variantId, 'A');
  assert.equal(skilled.status, 'SELECTION_SUPPORTED');
  const luck = trendPilotSelectionAuditV1([1, 2, 3, 4, 5].map((i) => ({ variantId: `V${i}`, returns: series(60, 0.0, 10 + i) })));
  assert.notEqual(luck.status, 'SELECTION_SUPPORTED');
  assert.equal(luck.executionAuthority, 'NONE');
});

test('more untracked trials only raises the bar; few trades, constant returns and bad input fail closed', () => {
  const base = [1, 2, 3].map((i) => ({ variantId: `V${i}`, returns: series(80, i === 1 ? 0.012 : 0.004, 20 + i) }));
  const a = trendPilotSelectionAuditV1(base);
  const b = trendPilotSelectionAuditV1(base, { extraTrials: 200 });
  assert.ok(b.best.deflatedSharpe <= a.best.deflatedSharpe);
  assert.equal(trendPilotSelectionAuditV1([{ variantId: 'x', returns: series(10, 0.05, 1) }, { variantId: 'y', returns: series(10, 0.01, 2) }]).status, 'TOO_FEW_TRADES');
  assert.equal(trendPilotSelectionAuditV1([{ variantId: 'x', returns: [0.01, 0.01, 0.01] }, { variantId: 'y', returns: [0.01, 0.01] }]).status, 'INSUFFICIENT_VARIANTS');
  assert.equal(trendPilotSelectionAuditV1(null).status, 'INSUFFICIENT_VARIANTS');
  assert.equal(trendPilotSelectionAuditV1([{ variantId: 'x', returns: [Number.NaN, 1, 2] }]).status, 'INSUFFICIENT_VARIANTS');
});
