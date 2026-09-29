import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceDisplayState, resolveEvidenceDisplay } from './evidence-display-contract.mjs';

test('actual numeric zero remains a real measured value', () => {
  const result = resolveEvidenceDisplay({ value: 0 });
  assert.equal(result.state, EvidenceDisplayState.VALUE);
  assert.equal(result.display, '0');
  assert.equal(result.value, 0);
  assert.equal(result.isActualZero, true);
  assert.equal(result.evidenceAvailable, true);
});

test('null and undefined are uncollected, never zero', () => {
  for (const value of [null, undefined]) {
    const result = resolveEvidenceDisplay({ value });
    assert.equal(result.state, EvidenceDisplayState.NOT_COLLECTED);
    assert.equal(result.display, '미수집');
    assert.notEqual(result.display, '0');
    assert.equal(result.value, null);
  }
});

test('N/A, stale, unavailable, and permission states stay explicit', () => {
  const cases = [
    [{ value: 123, applicable: false }, EvidenceDisplayState.N_A, 'N/A · 해당 없음'],
    [{ value: 123, stale: true }, EvidenceDisplayState.STALE, '오래된 데이터'],
    [{ value: 123, available: false }, EvidenceDisplayState.UNAVAILABLE, '사용 불가'],
    [{ value: 123, permitted: false }, EvidenceDisplayState.PERMISSION_REQUIRED, '권한 없음'],
  ];
  for (const [input, expectedState, expectedDisplay] of cases) {
    const result = resolveEvidenceDisplay(input);
    assert.equal(result.state, expectedState);
    assert.equal(result.display, expectedDisplay);
    assert.notEqual(result.display, '0');
    assert.equal(result.evidenceAvailable, false);
  }
});

test('non-finite values fail closed as unavailable', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const result = resolveEvidenceDisplay({ value });
    assert.equal(result.state, EvidenceDisplayState.UNAVAILABLE);
    assert.equal(result.display, '사용 불가');
  }
});

test('formatter is used only for actual values including zero', () => {
  let calls = 0;
  const formatter = (value) => {
    calls += 1;
    return `${value}%`;
  };
  assert.equal(resolveEvidenceDisplay({ value: 0, formatter }).display, '0%');
  assert.equal(calls, 1);
  assert.equal(resolveEvidenceDisplay({ value: null, formatter }).display, '미수집');
  assert.equal(resolveEvidenceDisplay({ value: 3, stale: true, formatter }).display, '오래된 데이터');
  assert.equal(calls, 1);
});

test('explicit non-value state wins over a present numeric value', () => {
  const result = resolveEvidenceDisplay({ value: 0, state: EvidenceDisplayState.PERMISSION_REQUIRED });
  assert.equal(result.state, EvidenceDisplayState.PERMISSION_REQUIRED);
  assert.equal(result.display, '권한 없음');
  assert.equal(result.isActualZero, false);
});
