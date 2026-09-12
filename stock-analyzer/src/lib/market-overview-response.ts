import type { Briefing, SectorPopularData } from '@/lib/api';

type Market = 'KR' | 'US';

const BRIEFING_MAX_AGE_MS = 5 * 60 * 1000;
const BRIEFING_FUTURE_SKEW_MS = 5 * 1000;
const SECTOR_POPULAR_MAX_AGE_MS = 2 * 60 * 1000;
const SECTOR_POPULAR_FUTURE_SKEW_MS = 5 * 1000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validSectorRow(value: unknown, market: Market): boolean {
  if (!record(value)) return false;
  if (!Number.isInteger(value.rank) || (value.rank as number) < 1) return false;
  if (!text(value.ticker) || !text(value.name)) return false;
  if (value.market !== market) return false;
  if (value.currency !== (market === 'KR' ? 'KRW' : 'USD')) return false;
  if (!finite(value.price) || value.price <= 0) return false;
  if (!finite(value.changePercent)) return false;
  if (value.tradingValue !== undefined && !finite(value.tradingValue)) return false;
  if (value.volume !== undefined && !finite(value.volume)) return false;
  return true;
}

export function requireSectorPopularData(
  payload: unknown,
  market: Market,
  nowMs = Date.now(),
): SectorPopularData {
  if (!record(payload) || payload.market !== market) throw new Error('INVALID_SECTOR_POPULAR_RESPONSE');
  if (!text(payload.sortBasis) || !Array.isArray(payload.sectors) || !text(payload.updatedAt)) {
    throw new Error('INVALID_SECTOR_POPULAR_RESPONSE');
  }
  const updatedAtMs = Date.parse(payload.updatedAt);
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) {
    throw new Error('INVALID_SECTOR_POPULAR_RESPONSE');
  }
  if (
    updatedAtMs > nowMs + SECTOR_POPULAR_FUTURE_SKEW_MS
    || updatedAtMs < nowMs - SECTOR_POPULAR_MAX_AGE_MS
  ) {
    throw new Error('INVALID_SECTOR_POPULAR_RESPONSE');
  }
  const valid = payload.sectors.every((sector) =>
    record(sector)
    && text(sector.key)
    && text(sector.label)
    && Array.isArray(sector.rows)
    && sector.rows.every((row) => validSectorRow(row, market)),
  );
  if (!valid) throw new Error('INVALID_SECTOR_POPULAR_RESPONSE');
  const hasEvidence = payload.sectors.some(
    (sector) => record(sector) && Array.isArray(sector.rows) && sector.rows.length > 0,
  );
  if (!hasEvidence) throw new Error('INVALID_SECTOR_POPULAR_RESPONSE');
  return payload as unknown as SectorPopularData;
}

function validBriefingRow(value: unknown): boolean {
  return record(value);
}

export function requireBriefing(payload: unknown, nowMs = Date.now()): Briefing {
  if (!record(payload)) throw new Error('INVALID_BRIEFING_RESPONSE');
  if (!text(payload.asOf)) throw new Error('INVALID_BRIEFING_RESPONSE');
  const asOfMs = Date.parse(payload.asOf);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(nowMs)) throw new Error('INVALID_BRIEFING_RESPONSE');
  if (asOfMs > nowMs + BRIEFING_FUTURE_SKEW_MS || asOfMs < nowMs - BRIEFING_MAX_AGE_MS) {
    throw new Error('INVALID_BRIEFING_RESPONSE');
  }
  if (!['positive', 'neutral', 'negative'].includes(String(payload.mood))) throw new Error('INVALID_BRIEFING_RESPONSE');
  if (!text(payload.headline) || !stringArray(payload.lines)) throw new Error('INVALID_BRIEFING_RESPONSE');
  for (const key of ['strongSectors', 'weakSectors', 'positiveNews', 'negativeNews', 'disclosureRisks', 'gainers', 'losers', 'picks']) {
    const value = payload[key];
    if (!Array.isArray(value) || !value.every(validBriefingRow)) throw new Error('INVALID_BRIEFING_RESPONSE');
  }
  return payload as unknown as Briefing;
}
