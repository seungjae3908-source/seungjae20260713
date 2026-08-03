import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLiveAiScore } from './signal.service';

const item = (score: number | null, status = score == null ? 'unavailable' : 'ok') => ({
  score,
  status,
  reasons: [],
});

test('live AI score renormalizes weights across only available factors', () => {
  assert.equal(computeLiveAiScore({
    trend: item(80),
    technical: item(80),
    news: item(null),
    financial: item(null),
    risk: item(100),
  } as any), 80);
});

test('live AI score applies an explicit risk deduction', () => {
  assert.equal(computeLiveAiScore({
    trend: item(80),
    technical: item(80),
    risk: item(50),
  } as any), 70);
});

test('live AI score stays in the normalized 0 to 100 range', () => {
  assert.equal(computeLiveAiScore({ trend: item(100), risk: item(0) } as any), 80);
  assert.equal(computeLiveAiScore({ risk: item(0) } as any), 0);
});

test('stale factors are reported but excluded from the normalized score', () => {
  assert.equal(computeLiveAiScore({
    trend: item(100, 'stale'),
    technical: item(50),
    risk: item(100),
  } as any), 50);
});
