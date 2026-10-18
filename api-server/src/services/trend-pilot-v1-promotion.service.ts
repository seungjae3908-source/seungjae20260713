// Trend pilot v1 — paper-promotion gate (fail closed).
//
// The live exception in trend-pilot-v1-authorization.service.ts replaces the
// generic research attestation. It must NOT replace the owner's paper criteria:
// a strategy may only place live orders after its PAPER track record passed
//   * at least 30 closed paper trades, after costs
//   * 95% lower confidence bound of the mean trade return > 0
//   * at least 3 distinct symbols
//   * at least 60% winning trades (overall win rate)
// The evidence is a signed record file written by the research side (never by
// this process). Anything missing, unsigned, expired, for another strategy or
// below a threshold denies the live exception. It never grants authority by
// itself: every other live gate still runs.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const TREND_PILOT_PROMOTION_SCHEMA = 'trend-pilot-promotion-v1';
export const TREND_PILOT_PROMOTION_MIN_TRADES = 30;
export const TREND_PILOT_PROMOTION_MIN_SYMBOLS = 3;
export const TREND_PILOT_PROMOTION_MIN_WIN_RATE = 0.6;
export const TREND_PILOT_PROMOTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_KEY_LENGTH = 32;
const MAX_FILE_BYTES = 256 * 1024;

export type TrendPilotPromotionRecord = {
  schemaVersion: typeof TREND_PILOT_PROMOTION_SCHEMA;
  strategyId: string;
  source: 'PAPER';
  afterCosts: true;
  closedTrades: number;
  distinctSymbols: number;
  winRate: number; // 0..1, overall win rate of closed trades
  meanReturnPercent: number;
  lowerBound95Percent: number; // 95% lower bound of the mean trade return
  issuedAtMs: number;
  expiresAtMs: number;
  signature: string;
};

export type TrendPilotPromotionCheck = { ok: true } | { ok: false; code: string };

export function trendPilotPromotionKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = String(env.TREND_PILOT_PROMOTION_KEY ?? '').trim();
  return key.length >= MIN_KEY_LENGTH ? key : null;
}

function num(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toPrecision(12) : '-';
}

function canonical(record: Omit<TrendPilotPromotionRecord, 'signature'>): string {
  return [
    record.schemaVersion, record.strategyId, record.source, String(record.afterCosts),
    num(record.closedTrades), num(record.distinctSymbols), num(record.winRate),
    num(record.meanReturnPercent), num(record.lowerBound95Percent),
    num(record.issuedAtMs), num(record.expiresAtMs),
  ].join('|');
}

/** Research side only: signs a promotion record. */
export function signTrendPilotPromotion(
  record: Omit<TrendPilotPromotionRecord, 'signature'>,
  key: string,
): TrendPilotPromotionRecord {
  if (!key || key.length < MIN_KEY_LENGTH) throw new Error('TREND_PILOT_PROMOTION_KEY_REQUIRED');
  const signature = createHmac('sha256', key).update(canonical(record)).digest('hex');
  return { ...record, signature };
}

function signatureValid(record: TrendPilotPromotionRecord, key: string): boolean {
  if (typeof record.signature !== 'string') return false;
  const { signature, ...rest } = record;
  const expected = createHmac('sha256', key).update(canonical(rest)).digest('hex');
  const given = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Pure check of one record against the owner's fixed paper criteria. */
export function checkTrendPilotPromotionRecord(
  record: unknown,
  strategyId: string,
  nowMs: number,
  key: string,
): TrendPilotPromotionCheck {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, code: 'TREND_PILOT_PROMOTION_INVALID' };
  const r = record as TrendPilotPromotionRecord;
  if (r.schemaVersion !== TREND_PILOT_PROMOTION_SCHEMA || r.source !== 'PAPER' || r.afterCosts !== true) {
    return { ok: false, code: 'TREND_PILOT_PROMOTION_INVALID' };
  }
  if (r.strategyId !== strategyId) return { ok: false, code: 'TREND_PILOT_PROMOTION_INVALID' };
  if (!signatureValid(r, key)) return { ok: false, code: 'TREND_PILOT_PROMOTION_INVALID' };
  for (const field of ['closedTrades', 'distinctSymbols', 'winRate', 'meanReturnPercent', 'lowerBound95Percent', 'issuedAtMs', 'expiresAtMs'] as const) {
    if (typeof r[field] !== 'number' || !Number.isFinite(r[field])) return { ok: false, code: 'TREND_PILOT_PROMOTION_INVALID' };
  }
  if (r.issuedAtMs > nowMs + 5_000) return { ok: false, code: 'TREND_PILOT_PROMOTION_INVALID' };
  if (nowMs >= r.expiresAtMs || nowMs - r.issuedAtMs > TREND_PILOT_PROMOTION_MAX_AGE_MS) {
    return { ok: false, code: 'TREND_PILOT_PROMOTION_EXPIRED' };
  }
  if (r.closedTrades < TREND_PILOT_PROMOTION_MIN_TRADES
    || r.distinctSymbols < TREND_PILOT_PROMOTION_MIN_SYMBOLS
    || r.winRate < TREND_PILOT_PROMOTION_MIN_WIN_RATE || r.winRate > 1
    || !(r.lowerBound95Percent > 0)) {
    return { ok: false, code: 'TREND_PILOT_PROMOTION_CRITERIA_NOT_MET' };
  }
  return { ok: true };
}

/**
 * Reads the signed record file named by TREND_PILOT_PROMOTION_RECORD_PATH
 * ({ "records": [ ...one signed record per strategy id... ] }) and checks the
 * record for `strategyId`. Never throws; any problem denies.
 */
export function checkTrendPilotPromotion(
  strategyId: string,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => {
    const text = readFileSync(path, 'utf8');
    if (text.length > MAX_FILE_BYTES) throw new Error('promotion record too large');
    return text;
  },
): TrendPilotPromotionCheck {
  const key = trendPilotPromotionKey(env);
  const path = String(env.TREND_PILOT_PROMOTION_RECORD_PATH ?? '').trim();
  if (!key || !path) return { ok: false, code: 'TREND_PILOT_PROMOTION_REQUIRED' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path));
  } catch {
    return { ok: false, code: 'TREND_PILOT_PROMOTION_REQUIRED' };
  }
  const records = (parsed as { records?: unknown })?.records;
  if (!Array.isArray(records)) return { ok: false, code: 'TREND_PILOT_PROMOTION_INVALID' };
  const match = records.find((row) => (row as { strategyId?: unknown })?.strategyId === strategyId);
  if (!match) return { ok: false, code: 'TREND_PILOT_PROMOTION_REQUIRED' };
  return checkTrendPilotPromotionRecord(match, strategyId, nowMs, key);
}
