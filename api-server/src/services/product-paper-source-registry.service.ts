import { randomUUID } from 'node:crypto';
import { resolveCanonicalStrategyIdentity } from '../../../market-prediction-lab/src/canonical-strategy-identity-v1.js';
import type { BacktestRequest } from './backtest-engine.service';
import type { BacktestPaperHandoff } from '../../../packages/strategy-hypothesis/src/backtest-paper-handoff.js';
import { parseBacktestPaperHandoff } from '../../../packages/strategy-hypothesis/src/backtest-paper-handoff.js';
import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import { resolveScannerCanonicalPaperIdentity } from './scanner-canonical-paper-identity.service';
import type { ScannerProfileMarket } from './scanner-strategy-profile.service';
import { assertPaperApprovalEnvelope } from './trade-approval-paper-guard.service';

// Product source lookup only. Neither this cache nor a successful comparison
// is Paper admission, a validation receipt, frozen research credit or execution.
const MAX_RECORDS = 256;
const MAX_SOURCE_AGE_MS = 30_000;
const SHA = /^[0-9a-f]{40}$/u;
const MARKET: Readonly<Record<string, ScannerProfileMarket>> = Object.freeze({
  KR: 'KR_STOCK', US: 'US_STOCK', SPOT: 'CRYPTO_SPOT', FUTURES: 'CRYPTO_FUTURES',
  UPBIT: 'CRYPTO_SPOT', BITGET: 'CRYPTO_FUTURES',
  KR_STOCK: 'KR_STOCK', US_STOCK: 'US_STOCK', CRYPTO_SPOT: 'CRYPTO_SPOT', CRYPTO_FUTURES: 'CRYPTO_FUTURES',
});
type ScannerSource = Readonly<{
  kind: 'SCANNER'; accountId: string; sourceId: string; sourceSha: string;
  storedAtMs: number; expiresAtMs: number; timeframe: string;
  card: ScannerSignalCard;
}>;
type BacktestSource = Readonly<{
  kind: 'BACKTEST'; accountId: string; sourceId: string; sourceSha: string;
  storedAtMs: number; expiresAtMs: number; request: BacktestRequest;
  handoff: BacktestPaperHandoff;
  strategyIdentityInput: Readonly<Record<string, unknown>>;
}>;
type Source = ScannerSource | BacktestSource;

export class ProductPaperSourceError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
function fail(code: string, status?: number): never { throw new ProductPaperSourceError(code, status); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PAPER_SOURCE_REQUEST_INVALID', 400);
  return value as Record<string, unknown>;
}
function token(value: unknown, max = 120): string {
  if (typeof value !== 'string' || !value || value.length > max || value !== value.trim()) fail('PAPER_SOURCE_REFERENCE_REQUIRED', 400);
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function envelope(body: Record<string, unknown>) {
  assertPaperApprovalEnvelope(body, { requireAccountMode: true });
  if (body.mode !== 'approval' || body.accountMode !== 'paper' || body.adapter !== 'paper') fail('PAPER_ONLY_APPROVAL_REQUIRED', 400);
  for (const key of ['receipt', 'validationReceipt', 'canonicalEvidence', 'executionEvidence', 'riskEvidence', 'paperState', 'state', 'order']) {
    if (key in body) fail('CLIENT_PAPER_AUTHORITY_FORBIDDEN', 400);
  }
  if (body.executionAuthority != null || body.privateTradingApiAllowed === true || body.realOrderEnabled === true) {
    fail('CLIENT_PAPER_AUTHORITY_FORBIDDEN', 400);
  }
}

export class ProductPaperSourceRegistry {
  private readonly records = new Map<string, Source>();
  constructor(private readonly now: () => number = Date.now) {}
  private key(kind: Source['kind'], accountId: string, sourceId: string, reference: string) {
    return JSON.stringify([kind, accountId, sourceId, reference]);
  }
  private prune() {
    const nowMs = this.now();
    for (const [key, source] of this.records) if (source.expiresAtMs <= nowMs) this.records.delete(key);
  }
  private put(key: string, source: Source) {
    this.prune();
    // A duplicate source reference cannot refresh its timestamp or substitute
    // another result. Saturation rejects new references: evicting a still-live
    // key would permit that reference to be rehydrated with another snapshot.
    if (this.records.has(key) || this.records.size >= MAX_RECORDS) return false;
    this.records.set(key, freeze(structuredClone(source)));
    return true;
  }
  captureScanner(accountId: string, response: ScannerResponse, sourceSha: string): void {
    const nowMs = this.now();
    if (!accountId || !SHA.test(sourceSha) || response.execution.cancelled) return;
    for (const card of response.cards.slice(0, 100)) {
      const observedAtMs = Date.parse(card.observedAt);
      const expiresAtMs = Math.min(Date.parse(card.expiresAt), nowMs + MAX_SOURCE_AGE_MS, observedAtMs + MAX_SOURCE_AGE_MS);
      if (!card.signalId || !Number.isFinite(expiresAtMs) || observedAtMs > nowMs || expiresAtMs <= nowMs) continue;
      const source: ScannerSource = {
        kind: 'SCANNER', accountId, sourceId: response.requestId, sourceSha,
        storedAtMs: nowMs, expiresAtMs, timeframe: response.timeframe, card,
      };
      this.put(this.key('SCANNER', accountId, response.requestId, card.signalId), source);
    }
  }
  captureBacktest(
    accountId: string, request: BacktestRequest, handoffs: readonly BacktestPaperHandoff[], sourceSha: string,
    strategyIdentityInputs: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
  ): string | null {
    if (!accountId || !SHA.test(sourceSha) || !handoffs.length) return null;
    const nowMs = this.now();
    // Run metadata, not a new candidate namespace. Same candidate on two
    // searches still requires the exact explicit run reference, never latest.
    const sourceId = randomUUID();
    let count = 0;
    for (const raw of handoffs) {
      const handoff = parseBacktestPaperHandoff(raw);
      if (!handoff?.candidateId || !handoff.strategyId || !handoff.parameterHash || !handoff.symbol || !handoff.timeframe || !handoff.side || !handoff.leverage) continue;
      if (handoff.symbol !== request.symbol || handoff.timeframe !== request.timeframe || handoff.leverage !== request.leverage
        || handoff.strategyId !== `BACKTEST_ENGINE:${request.strategy}`
        || (request.side !== 'both' && handoff.side !== (request.side === 'long' ? 'LONG' : 'SHORT'))) continue;
      const strategyIdentityInput = strategyIdentityInputs[handoff.candidateId];
      const resolvedIdentity = resolveCanonicalStrategyIdentity(strategyIdentityInput);
      if (resolvedIdentity.status !== 'IDENTITY_COMPLETE' || !resolvedIdentity.identity) continue;
      const canonical = resolvedIdentity.identity;
      if (canonical.strategyId !== handoff.strategyId || canonical.parameterHash !== handoff.parameterHash
        || canonical.market !== handoff.market || canonical.direction !== handoff.side
        || canonical.timeframe !== handoff.timeframe || canonical.researchCodeSha !== sourceSha
        || canonical.costPolicyVersion !== handoff.costPolicyRef || canonical.riskPolicyVersion !== handoff.riskPolicyRef) continue;
      const source: BacktestSource = {
        kind: 'BACKTEST', accountId, sourceId, sourceSha, storedAtMs: nowMs,
        expiresAtMs: nowMs + MAX_SOURCE_AGE_MS, request, handoff,
        strategyIdentityInput: freeze(structuredClone(strategyIdentityInput)),
      };
      if (this.put(this.key('BACKTEST', accountId, sourceId, handoff.candidateId), source)) count += 1;
    }
    return count ? sourceId : null;
  }
  private read(kind: Source['kind'], accountId: string, sourceId: string, reference: string, currentSha: string): Source {
    this.prune();
    if (!accountId) fail('LOGIN_REQUIRED', 401);
    if (!SHA.test(currentSha)) fail('IMMUTABLE_RESEARCH_SHA_REQUIRED');
    const source = this.records.get(this.key(kind, accountId, sourceId, reference));
    if (!source) fail('PAPER_SOURCE_NOT_RESOLVABLE');
    if (source.sourceSha !== currentSha) fail('PAPER_SOURCE_CODE_SHA_MISMATCH');
    const nowMs = this.now();
    if (source.storedAtMs > nowMs || source.expiresAtMs <= nowMs) fail('PAPER_SOURCE_STALE');
    return source;
  }
  resolveScanner(accountId: string, value: unknown, currentSha: string) {
    const body = object(value);
    envelope(body);
    const market = MARKET[token(body.market, 32)];
    if (!market) fail('SCANNER_MARKET_INVALID', 400);
    const side = token(body.side, 20);
    if (!(market === 'CRYPTO_FUTURES' ? ['LONG', 'SHORT'] : ['BUY']).includes(side)) fail('SCANNER_EXPLICIT_ENTRY_SIDE_REQUIRED', 400);
    const source = this.read('SCANNER', accountId, token(body.searchRunId), token(body.signalId), currentSha) as ScannerSource;
    const card = source.card;
    if (card.symbol !== token(body.symbol, 32)) fail('SCANNER_SYMBOL_MISMATCH');
    if (source.timeframe !== token(body.timeframe, 12)) fail('SCANNER_TIMEFRAME_MISMATCH');
    if (card.action !== side) fail('SCANNER_DIRECTION_MISMATCH');
    if ((side === 'BUY' || side === 'LONG') && card.direction !== 'LONG') fail('SCANNER_SIGNAL_DIRECTION_CONFLICT');
    if (side === 'SHORT' && card.direction !== 'SHORT') fail('SCANNER_SIGNAL_DIRECTION_CONFLICT');
    if (body.selectedConditions !== undefined) {
      if (!Array.isArray(body.selectedConditions) || !body.selectedConditions.length || body.selectedConditions.length > 20
        || body.selectedConditions.some(item => typeof item !== 'string' || !item.trim() || item.length > 160 || !card.matched.includes(item))) {
        fail('SCANNER_AND_CONDITIONS_NOT_MAINTAINED');
      }
    }
    if (!card.strongSignalEligible || card.signalState === 'INVALIDATED' || card.dataState !== 'complete'
      || !card.dataSources.length || card.dataSources.some(item => !item.trim())) fail('SCANNER_SOURCE_NOT_EXECUTION_ELIGIBLE');
    const resolution = resolveScannerCanonicalPaperIdentity({ card, market, researchCodeSha: source.sourceSha });
    if (!resolution.paperCandidate) fail(resolution.blockers[0] ?? 'SCANNER_CANONICAL_IDENTITY_REQUIRED');
    const candidate = resolution.paperCandidate;
    if (candidate.signal.timeframe !== body.timeframe) fail('SCANNER_CANONICAL_TIMEFRAME_MISMATCH');
    for (const field of ['candidateId', 'strategyId', 'parameterHash'] as const) {
      const expected = candidate.signal.strategyIdentity[field];
      if (body[field] !== undefined && body[field] !== expected) fail(`SCANNER_${field.toUpperCase()}_MISMATCH`);
    }
    // The canonical Scanner identity does not issue a leverage policy. A client
    // value cannot fill that gap; the server admission owner must resolve it.
    if (body.leverage !== undefined && body.leverage !== null) fail('SERVER_LEVERAGE_PROVENANCE_REQUIRED');
    return freeze({ source, paperCandidate: candidate, originalSignalDirection: card.direction });
  }
  resolveScannerLiveDraft(accountId: string, value: unknown, currentSha: string) {
    const body = object(value);
    if (body.mode !== 'approval' || body.accountMode !== 'live' || body.adapter !== 'canonical-live') {
      fail('LIVE_DRAFT_APPROVAL_ENVELOPE_REQUIRED', 400);
    }
    for (const key of [
      'marketSnapshot',
      'economics',
      'riskAssessment',
      'riskEnvelope',
      'executionAuthority',
      'privateTradingApiAllowed',
      'realOrderEnabled',
      'liveOrderEnabled',
      'order',
      'quantity',
      'quoteAmount',
      'limitPrice',
      'stopPrice',
      'targetPrices',
      'splitRatios',
      'leverage',
      'marginMode',
      'reduceOnly',
    ]) {
      if (key in body) fail('CLIENT_LIVE_DRAFT_AUTHORITY_FORBIDDEN', 400);
    }

    const market = MARKET[token(body.market, 32)];
    if (!market) fail('SCANNER_MARKET_INVALID', 400);
    const side = token(body.side, 20);
    if (!(market === 'CRYPTO_FUTURES' ? ['LONG', 'SHORT'] : ['BUY']).includes(side)) {
      fail('SCANNER_EXPLICIT_ENTRY_SIDE_REQUIRED', 400);
    }
    const source = this.read('SCANNER', accountId, token(body.searchRunId), token(body.signalId), currentSha) as ScannerSource;
    const card = source.card;
    if (card.symbol !== token(body.symbol, 32)) fail('SCANNER_SYMBOL_MISMATCH');
    if (source.timeframe !== token(body.timeframe, 12)) fail('SCANNER_TIMEFRAME_MISMATCH');
    if (card.action !== side) fail('SCANNER_DIRECTION_MISMATCH');
    if ((side === 'BUY' || side === 'LONG') && card.direction !== 'LONG') fail('SCANNER_SIGNAL_DIRECTION_CONFLICT');
    if (side === 'SHORT' && card.direction !== 'SHORT') fail('SCANNER_SIGNAL_DIRECTION_CONFLICT');
    if (body.selectedConditions !== undefined) {
      if (!Array.isArray(body.selectedConditions) || !body.selectedConditions.length || body.selectedConditions.length > 20
        || body.selectedConditions.some(item => typeof item !== 'string' || !item.trim() || item.length > 160 || !card.matched.includes(item))) {
        fail('SCANNER_AND_CONDITIONS_NOT_MAINTAINED');
      }
    }
    if (!card.strongSignalEligible || card.signalState === 'INVALIDATED' || card.dataState !== 'complete'
      || !card.dataSources.length || card.dataSources.some(item => !item.trim())) {
      fail('SCANNER_SOURCE_NOT_EXECUTION_ELIGIBLE');
    }
    if (!card.pricePlan.entryZone
      || !(Number.isFinite(card.pricePlan.entryZone.from) && card.pricePlan.entryZone.from > 0)
      || !(Number.isFinite(card.pricePlan.entryZone.to) && card.pricePlan.entryZone.to > 0)
      || !(Number.isFinite(card.pricePlan.stopLoss) && Number(card.pricePlan.stopLoss) > 0)
      || !Array.isArray(card.pricePlan.targets)
      || !card.pricePlan.targets.some((value) => Number.isFinite(value) && value > 0)) {
      fail('SCANNER_LIVE_PRICE_PLAN_REQUIRED');
    }

    const resolution = resolveScannerCanonicalPaperIdentity({ card, market, researchCodeSha: source.sourceSha });
    if (!resolution.paperCandidate) fail(resolution.blockers[0] ?? 'SCANNER_CANONICAL_IDENTITY_REQUIRED');
    const identity = resolution.paperCandidate.signal.strategyIdentity;
    return freeze({
      source,
      card,
      canonicalMarket: market,
      strategyIdentity: identity,
      originalSignalDirection: card.direction,
      executionAuthority: 'NONE' as const,
      orderSubmitted: false as const,
      exchangeRequestSent: false as const,
    });
  }

  resolveBacktest(accountId: string, value: unknown, currentSha: string) {
    const body = object(value);
    envelope(body);
    const claimed = parseBacktestPaperHandoff(body.backtestCandidate);
    if (!claimed?.candidateId) fail('INVALID_BACKTEST_PAPER_HANDOFF', 400);
    const source = this.read('BACKTEST', accountId, token(body.backtestRunId), claimed.candidateId, currentSha) as BacktestSource;
    for (const field of ['candidateId', 'strategyId', 'parameterHash', 'market', 'symbol', 'timeframe', 'side', 'leverage',
      'riskPolicyRef', 'costPolicyRef', 'exitPolicyRef'] as const) {
      if (claimed[field] !== source.handoff[field]) fail(`BACKTEST_${field.toUpperCase()}_MISMATCH`);
    }
    return source;
  }
}

export const productPaperSourceRegistry = new ProductPaperSourceRegistry();
