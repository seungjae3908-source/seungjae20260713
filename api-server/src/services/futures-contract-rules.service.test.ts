import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBitgetContractRules } from './futures-contract-rules.service';

const NOW = Date.UTC(2026, 7, 2, 0, 0, 0);
const baseRow = {
  symbol: 'BTCUSDT',
  symbolStatus: 'normal',
  sizeMultiplier: '0.001',
  minTradeNum: '0.001',
  minTradeUSDT: '5',
  volumePlace: '3',
  pricePlace: '1',
  priceEndStep: '1',
  minLever: '1',
  maxLever: '125',
};

function rules(patch: Record<string, unknown> = {}, requestTime: unknown = NOW) {
  return normalizeBitgetContractRules({ ...baseRow, ...patch }, 'BTCUSDT', requestTime, NOW);
}

test('normalizes quantity step from sizeMultiplier', () => {
  assert.equal(rules().quantityStep, 0.001);
});

test('normalizes minimum quantity from minTradeNum', () => {
  assert.equal(rules().minimumQuantity, 0.001);
});

test('normalizes minimum notional from minTradeUSDT', () => {
  assert.equal(rules().minimumNotional, 5);
});

test('normalizes quantity and price precision', () => {
  const result = rules();
  assert.equal(result.quantityPrecision, 3);
  assert.equal(result.pricePrecision, 1);
});

test('derives price step only from documented priceEndStep and pricePlace', () => {
  assert.equal(rules().priceStep, 0.1);
  assert.equal(rules({ priceEndStep: '5', pricePlace: '2' }).priceStep, 0.05);
});

test('normalizes minimum and maximum leverage when provided', () => {
  const result = rules();
  assert.equal(result.minimumLeverage, 1);
  assert.equal(result.maximumLeverage, 125);
});

test('keeps maintenance margin rate null because contracts response does not provide it', () => {
  const result = rules();
  assert.equal(result.maintenanceMarginRate, null);
  assert.ok(result.warnings.some((warning) => warning.includes('유지증거금률')));
});

test('ignores undocumented maintenance and contract size lookalike fields', () => {
  const result = rules({ minMaintainMarginRate: '0.005', contractSize: '0.001' });
  assert.equal(result.maintenanceMarginRate, null);
  assert.equal(result.contractSize, null);
});

test('empty numeric strings become null', () => {
  const result = rules({
    sizeMultiplier: '',
    minTradeNum: ' ',
    minTradeUSDT: '',
    maxLever: '',
  });
  assert.equal(result.quantityStep, null);
  assert.equal(result.minimumQuantity, null);
  assert.equal(result.minimumNotional, null);
  assert.equal(result.maximumLeverage, null);
});

test('NaN and Infinity values become null', () => {
  const result = rules({
    sizeMultiplier: 'NaN',
    minTradeNum: Number.POSITIVE_INFINITY,
    minTradeUSDT: Number.NEGATIVE_INFINITY,
  });
  assert.equal(result.quantityStep, null);
  assert.equal(result.minimumQuantity, null);
  assert.equal(result.minimumNotional, null);
});

test('negative rule values are rejected', () => {
  const result = rules({
    sizeMultiplier: '-0.001',
    minTradeNum: '-1',
    minTradeUSDT: '-5',
    volumePlace: '-3',
    pricePlace: '-1',
    maxLever: '-10',
  });
  assert.equal(result.quantityStep, null);
  assert.equal(result.minimumQuantity, null);
  assert.equal(result.minimumNotional, null);
  assert.equal(result.quantityPrecision, null);
  assert.equal(result.pricePrecision, null);
  assert.equal(result.maximumLeverage, null);
});

test('non-normal contract statuses are clearly insufficient', () => {
  for (const symbolStatus of ['listed', 'maintain', 'limit_open', 'restrictedAPI', 'off']) {
    const result = rules({ symbolStatus });
    assert.equal(result.status, 'insufficient');
    assert.ok(result.warnings.some((warning) => warning.includes('normal')));
  }
});

test('missing fields remain null and emit minimum rule warning', () => {
  const result = normalizeBitgetContractRules(
    { symbol: 'BTCUSDT', symbolStatus: 'normal' },
    'BTCUSDT',
    NOW,
    NOW,
  );
  assert.equal(result.quantityStep, null);
  assert.equal(result.minimumQuantity, null);
  assert.equal(result.minimumNotional, null);
  assert.ok(result.warnings.includes('거래소 최소 주문 규칙을 확인할 수 없습니다.'));
});

test('stale request time is delayed and missing request time is insufficient', () => {
  assert.equal(rules({}, NOW - 30 * 60_000).status, 'delayed');
  assert.equal(rules({}, null).status, 'insufficient');
});
