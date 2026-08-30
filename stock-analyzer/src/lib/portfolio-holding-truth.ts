export type PortfolioHoldingTruthCode =
  | 'INVALID_RESPONSE_SHAPE'
  | 'INVALID_ROW_SHAPE'
  | 'INVALID_IDENTITY'
  | 'DUPLICATE_IDENTITY'
  | 'INVALID_MARKET'
  | 'INVALID_CURRENCY'
  | 'INVALID_QUANTITY'
  | 'INVALID_AVERAGE_PRICE';

export type PortfolioHoldingTruthResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code: PortfolioHoldingTruthCode;
      rowIndex: number | null;
    }>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveFiniteNumberLike(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value !== 'string' || !/^\+?\d+(?:\.\d+)?$/.test(value.trim())) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

export function validatePortfolioHoldingRows(payload: unknown): PortfolioHoldingTruthResult {
  if (!Array.isArray(payload)) {
    return { ok: false, code: 'INVALID_RESPONSE_SHAPE', rowIndex: null };
  }

  const ids = new Set<string>();
  for (let index = 0; index < payload.length; index += 1) {
    const row = record(payload[index]);
    if (!row) return { ok: false, code: 'INVALID_ROW_SHAPE', rowIndex: index };

    if (typeof row.id !== 'string' || !row.id.trim()
      || typeof row.ticker !== 'string' || !row.ticker.trim()) {
      return { ok: false, code: 'INVALID_IDENTITY', rowIndex: index };
    }

    if (row.market !== 'KR' && row.market !== 'US') {
      return { ok: false, code: 'INVALID_MARKET', rowIndex: index };
    }
    if (ids.has(row.id)) return { ok: false, code: 'DUPLICATE_IDENTITY', rowIndex: index };
    ids.add(row.id);

    const expectedCurrency = row.market === 'US' ? 'USD' : 'KRW';
    if (row.currency !== expectedCurrency) {
      return { ok: false, code: 'INVALID_CURRENCY', rowIndex: index };
    }

    if (!positiveFiniteNumberLike(row.quantity)) {
      return { ok: false, code: 'INVALID_QUANTITY', rowIndex: index };
    }

    if (!positiveFiniteNumberLike(row.average_price)) {
      return { ok: false, code: 'INVALID_AVERAGE_PRICE', rowIndex: index };
    }
  }

  return { ok: true };
}
