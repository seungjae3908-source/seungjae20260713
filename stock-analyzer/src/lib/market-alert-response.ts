import type { MarketAlert } from './api';

const FUTURE_TOLERANCE_MS = 30_000;
const ENVELOPE_STALE_MS = 2 * 60_000;
const MARKETS = new Set(['ALL', 'KR', 'US']);
const ALERT_MARKETS = new Set(['KR', 'US']);
const IMPORTANCE = new Set<MarketAlert['importance']>(['high', 'medium', 'low']);

export type MarketAlertFeedResponse = {
  market: 'ALL' | 'KR' | 'US';
  positive: MarketAlert[];
  negative: MarketAlert[];
  alerts: MarketAlert[];
  updatedAt: string;
};

export class MarketAlertFeedContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketAlertFeedContractError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MarketAlertFeedContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new MarketAlertFeedContractError(`${label} must be a${allowEmpty ? '' : ' non-empty'} string`);
  }
  return value;
}

function timestampField(value: unknown, label: string, nowMs: number): { iso: string; ms: number } {
  const iso = stringField(value, label);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new MarketAlertFeedContractError(`${label} must be a valid timestamp`);
  }
  if (ms > nowMs + FUTURE_TOLERANCE_MS) {
    throw new MarketAlertFeedContractError(`${label} is in the future`);
  }
  return { iso, ms };
}

function parseAlert(value: unknown, label: string, nowMs: number): MarketAlert {
  const row = record(value, label);
  const id = stringField(row.id, `${label}.id`);
  const ticker = stringField(row.ticker, `${label}.ticker`);
  const name = stringField(row.name, `${label}.name`);
  const market = stringField(row.market, `${label}.market`);
  if (!ALERT_MARKETS.has(market)) {
    throw new MarketAlertFeedContractError(`${label}.market is invalid`);
  }
  const kind = stringField(row.kind, `${label}.kind`);
  if (kind !== 'positive' && kind !== 'negative') {
    throw new MarketAlertFeedContractError(`${label}.kind is invalid`);
  }
  const category = stringField(row.category, `${label}.category`);
  const title = stringField(row.title, `${label}.title`);
  const importance = stringField(row.importance, `${label}.importance`);
  if (!IMPORTANCE.has(importance as MarketAlert['importance'])) {
    throw new MarketAlertFeedContractError(`${label}.importance is invalid`);
  }
  const time = timestampField(row.time, `${label}.time`, nowMs).iso;
  const url = row.url;
  if (url !== null && typeof url !== 'string') {
    throw new MarketAlertFeedContractError(`${label}.url must be null or string`);
  }

  return {
    id,
    ticker,
    name,
    market: market as MarketAlert['market'],
    kind,
    category,
    title,
    importance: importance as MarketAlert['importance'],
    time,
    url,
  };
}

function ids(rows: MarketAlert[], label: string): Set<string> {
  const result = new Set<string>();
  for (const row of rows) {
    if (result.has(row.id)) {
      throw new MarketAlertFeedContractError(`${label} contains duplicate id ${row.id}`);
    }
    result.add(row.id);
  }
  return result;
}

function sameIds(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
}

export function parseMarketAlertFeed(input: unknown, nowMs = Date.now()): MarketAlertFeedResponse {
  const envelope = record(input, 'market alert feed');
  const market = stringField(envelope.market, 'market alert feed.market');
  if (!MARKETS.has(market)) {
    throw new MarketAlertFeedContractError('market alert feed.market is invalid');
  }
  if (!Array.isArray(envelope.positive) || !Array.isArray(envelope.negative) || !Array.isArray(envelope.alerts)) {
    throw new MarketAlertFeedContractError('market alert feed arrays are required');
  }

  const positive = envelope.positive.map((row, index) => parseAlert(row, `market alert feed.positive[${index}]`, nowMs));
  const negative = envelope.negative.map((row, index) => parseAlert(row, `market alert feed.negative[${index}]`, nowMs));
  const alerts = envelope.alerts.map((row, index) => parseAlert(row, `market alert feed.alerts[${index}]`, nowMs));

  if (positive.some((row) => row.kind !== 'positive')) {
    throw new MarketAlertFeedContractError('market alert feed.positive contains non-positive row');
  }
  if (negative.some((row) => row.kind !== 'negative')) {
    throw new MarketAlertFeedContractError('market alert feed.negative contains non-negative row');
  }

  const alertIds = ids(alerts, 'market alert feed.alerts');
  const partition = [...positive, ...negative];
  const partitionIds = ids(partition, 'market alert feed partition');
  if (!sameIds(alertIds, partitionIds)) {
    throw new MarketAlertFeedContractError('market alert feed positive/negative partition mismatch');
  }

  const updatedAt = timestampField(envelope.updatedAt, 'market alert feed.updatedAt', nowMs);
  if (nowMs - updatedAt.ms > ENVELOPE_STALE_MS) {
    throw new MarketAlertFeedContractError('market alert feed.updatedAt is stale');
  }

  return {
    market: market as MarketAlertFeedResponse['market'],
    positive,
    negative,
    alerts,
    updatedAt: updatedAt.iso,
  };
}
