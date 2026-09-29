import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEARN_PROGRESS_STORAGE_KEY,
  normalizeLearnProgress,
  readLearnProgress,
  toggleLearnTopic,
  writeLearnProgress,
} from './learn-progress';

const valid = ['candlestick', 'trend', 'rsi'];

test('learn progress keeps only unique known topic ids', () => {
  const value = normalizeLearnProgress({
    completedTopicIds: ['trend', 'unknown', 'trend', 'rsi'],
    updatedAt: '2026-09-29T00:00:00.000Z',
  }, valid);
  assert.deepEqual(value.completedTopicIds, ['trend', 'rsi']);
});

test('corrupted storage fails closed to empty progress', () => {
  const storage = { getItem: () => '{not-json' };
  const value = readLearnProgress(storage, valid);
  assert.deepEqual(value.completedTopicIds, []);
});

test('toggle refuses unknown ids and write persists only valid progress', () => {
  assert.deepEqual(toggleLearnTopic(['trend'], 'unknown', valid), ['trend']);
  const saved: Record<string, string> = {};
  const storage = { setItem: (key: string, value: string) => { saved[key] = value; } };
  const value = writeLearnProgress(storage, ['trend', 'unknown'], valid, new Date('2026-09-29T00:00:00Z'));
  assert.deepEqual(value.completedTopicIds, ['trend']);
  assert.equal(JSON.parse(saved[LEARN_PROGRESS_STORAGE_KEY]).schemaVersion, 1);
});
