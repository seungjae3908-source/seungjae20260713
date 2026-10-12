import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { passesMinimumBacktestQuality } from './scanner-candidate-ranking.service';
import type { ScannerBacktestQualitySummary, ScannerSignalCard, ScannerTradeAction } from './scanner-signal.types';
import { StrategyPromotionService } from './strategy-promotion.service';
import type { ForwardObserverLane } from './forward-recommendation-observer-runtime.service';

const SHA40 = /^[0-9a-f]{40}$/iu;
const SHA64 = /^[0-9a-f]{64}$/iu;

export type ForwardObserverScannerQualityIdentity = Readonly<{
  strategyId: string;
  strategyVersion: string;
  parameterHash: string;
  researchCodeSha: string;
  market: ForwardObserverLane['market'];
  symbol: string;
  timeframe: ForwardObserverLane['timeframe'];
  direction: Exclude<ScannerTradeAction, 'NONE'>;
  datasetSnapshotHash: string;
}>;

export type ForwardObserverScannerQualityEntry = Readonly<{
  identity: ForwardObserverScannerQualityIdentity;
  quality: ScannerBacktestQualitySummary;
  executionAuthority: 'NONE';
  automaticPromotionAuthority: false;
  profitabilityClaimAllowed: false;
}>;

export type ForwardObserverScannerQualityArtifact = Readonly<{
  schemaVersion: 'forward-observer-scanner-quality-v1';
  researchCodeSha: string;
  entries: readonly ForwardObserverScannerQualityEntry[];
  safety: Readonly<{
    executionAuthority: 'NONE';
    financialMutationAllowed: false;
    liveOrderAllowed: false;
    privateTradingApiAllowed: false;
    profitabilityClaimAllowed: false;
  }>;
}>;

type Manifest = Readonly<{
  schemaVersion?: unknown;
  kind?: unknown;
  researchCodeSha?: unknown;
  qualitySha256?: unknown;
  safety?: Readonly<Record<string, unknown>>;
}>;

export type ForwardObserverQualitySelection = Readonly<{
  schemaVersion: 'forward-observer-scanner-quality-selection-v1';
  status: 'READY' | 'PARTIAL' | 'UNAVAILABLE' | 'BLOCKED_DATA';
  backtests: Readonly<Record<string, ScannerBacktestQualitySummary>>;
  matchedSymbols: readonly string[];
  blockers: readonly Readonly<{
    code: string;
    symbol: string | null;
    details?: Readonly<Record<string, unknown>>;
  }>[];
  executionAuthority: 'NONE';
  automaticPromotionAuthority: false;
  profitabilityClaimAllowed: false;
}>;

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Immutable OOS/WF quality lookup identity, NOT trade execution authority.
 * Stock/spot remains symbol-keyed for its one permitted long direction.
 * Crypto futures MUST include LONG/SHORT: a symbol-only record must never
 * promote the opposite side, including when both candidates share a symbol.
 */
export function scannerBacktestLookupKey(
  card: Pick<ScannerSignalCard, 'assetClass' | 'symbol' | 'direction'>,
): string | null {
  const symbol = typeof card.symbol === 'string' ? card.symbol.trim().toUpperCase() : '';
  if (!symbol) return null;
  if (card.assetClass === 'coin_futures') {
    if (card.direction !== 'LONG' && card.direction !== 'SHORT') return null;
    return JSON.stringify(['coin_futures', symbol, card.direction]);
  }
  // Stocks and spot are LONG-only; never lend a BUY result to a SHORT card.
  return card.direction === 'LONG' ? symbol : null;
}


function normalizeDirection(action: ScannerTradeAction | undefined, lane: ForwardObserverLane): Exclude<ScannerTradeAction, 'NONE'> | null {
  if (lane.market === 'CRYPTO_FUTURES') return action === 'LONG' || action === 'SHORT' ? action : null;
  // Stocks and spot cannot promote short-selling evidence on a LONG-only lane.
  return action === 'BUY' ? action : null;
}

function artifactSafetyValid(value: unknown): value is ForwardObserverScannerQualityArtifact['safety'] {
  const safety = value as ForwardObserverScannerQualityArtifact['safety'] | undefined;
  return safety?.executionAuthority === 'NONE'
    && safety.financialMutationAllowed === false
    && safety.liveOrderAllowed === false
    && safety.privateTradingApiAllowed === false
    && safety.profitabilityClaimAllowed === false;
}

function manifestSafetyValid(value: unknown): boolean {
  const safety = value as Record<string, unknown> | undefined;
  return safety?.executionAuthority === 'NONE'
    && safety.financialMutationAllowed === false
    && safety.liveOrderAllowed === false
    && safety.privateTradingApiAllowed === false
    && safety.profitabilityClaimAllowed === false;
}

function validateArtifactShape(artifact: ForwardObserverScannerQualityArtifact, researchCodeSha: string): void {
  if (artifact.schemaVersion !== 'forward-observer-scanner-quality-v1') throw new Error('SCANNER_QUALITY_ARTIFACT_SCHEMA_UNSUPPORTED');
  if (!SHA40.test(artifact.researchCodeSha) || artifact.researchCodeSha.toLowerCase() !== researchCodeSha.toLowerCase()) {
    throw new Error('SCANNER_QUALITY_ARTIFACT_RESEARCH_SHA_MISMATCH');
  }
  if (!artifactSafetyValid(artifact.safety)) throw new Error('SCANNER_QUALITY_ARTIFACT_SAFETY_INVALID');
  if (!Array.isArray(artifact.entries)) throw new Error('SCANNER_QUALITY_ARTIFACT_ENTRIES_REQUIRED');

  const seen = new Set<string>();
  for (const entry of artifact.entries) {
    const identity = entry?.identity;
    if (!identity
      || !nonEmpty(identity.strategyId)
      || !nonEmpty(identity.strategyVersion)
      || !SHA64.test(identity.parameterHash)
      || !SHA40.test(identity.researchCodeSha)
      || identity.researchCodeSha.toLowerCase() !== researchCodeSha.toLowerCase()
      || !nonEmpty(identity.symbol)
      || !nonEmpty(identity.timeframe)
      || !SHA64.test(identity.datasetSnapshotHash)
      || !['BUY', 'SELL', 'LONG', 'SHORT'].includes(identity.direction)
      || entry.executionAuthority !== 'NONE'
      || entry.automaticPromotionAuthority !== false
      || entry.profitabilityClaimAllowed !== false) {
      throw new Error('SCANNER_QUALITY_ARTIFACT_ENTRY_INVALID');
    }
    if (!entry.quality
      || entry.quality.status !== 'verified'
      || entry.quality.costsIncluded !== true
      || entry.quality.slippageIncluded !== true
      || entry.quality.lookaheadGuarded !== true
      || entry.quality.survivorshipGuarded !== true
      || entry.quality.oos !== true
      || entry.quality.walkForward !== true) {
      throw new Error('SCANNER_QUALITY_ARTIFACT_ENTRY_NOT_VERIFIED');
    }
    const key = [
      identity.strategyId,
      identity.strategyVersion,
      identity.parameterHash,
      identity.researchCodeSha.toLowerCase(),
      identity.market,
      identity.symbol.toUpperCase(),
      identity.timeframe,
      identity.direction,
      identity.datasetSnapshotHash,
    ].join('|');
    if (seen.has(key)) throw new Error('SCANNER_QUALITY_ARTIFACT_DUPLICATE_ENTRY');
    seen.add(key);
  }
}

export async function readForwardObserverScannerQualityArtifact(input: Readonly<{
  artifactRoot: string;
  researchCodeSha: string;
}>): Promise<ForwardObserverScannerQualityArtifact> {
  const root = path.resolve(input.artifactRoot);
  const researchCodeSha = input.researchCodeSha.trim().toLowerCase();
  if (!SHA40.test(researchCodeSha)) throw new Error('SCANNER_QUALITY_RESEARCH_SHA_REQUIRED');

  const [manifestText, qualityText] = await Promise.all([
    readFile(path.join(root, 'manifest.json'), 'utf8'),
    readFile(path.join(root, 'quality.json'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText) as Manifest;
  if (manifest.schemaVersion !== 1
    || manifest.kind !== 'forward-observer-scanner-quality'
    || manifest.researchCodeSha !== researchCodeSha
    || manifest.qualitySha256 !== sha256Text(qualityText)
    || !manifestSafetyValid(manifest.safety)) {
    throw new Error('SCANNER_QUALITY_ARTIFACT_MANIFEST_INVALID');
  }
  const artifact = JSON.parse(qualityText) as ForwardObserverScannerQualityArtifact;
  validateArtifactShape(artifact, researchCodeSha);
  return Object.freeze({
    ...artifact,
    entries: Object.freeze(artifact.entries.map((entry) => Object.freeze({
      ...entry,
      identity: Object.freeze({ ...entry.identity }),
      quality: Object.freeze({ ...entry.quality }),
    }))),
    safety: Object.freeze({ ...artifact.safety }),
  });
}

function expectedPromotionIdentity(
  lane: ForwardObserverLane,
  direction: Exclude<ScannerTradeAction, 'NONE'>,
  researchCodeSha: string,
) {
  const records = new StrategyPromotionService({ sourceSha: researchCodeSha })
    .list({ market: lane.market, strategyHorizon: 'SWING', direction }).items;
  const exact = records.filter((record) =>
    record.identity.market === lane.market
    && record.identity.timeframe === lane.timeframe
    && record.identity.direction === direction
    && record.identity.researchCodeSha === researchCodeSha);
  return exact.length === 1 ? exact[0]!.identity : null;
}

export function selectForwardObserverScannerBacktests(input: Readonly<{
  artifact: ForwardObserverScannerQualityArtifact | null;
  cards: readonly ScannerSignalCard[];
  lane: ForwardObserverLane;
  researchCodeSha: string;
}>): ForwardObserverQualitySelection {
  const researchCodeSha = input.researchCodeSha.trim().toLowerCase();
  if (!input.artifact) {
    return Object.freeze({
      schemaVersion: 'forward-observer-scanner-quality-selection-v1',
      status: 'UNAVAILABLE',
      backtests: Object.freeze({}),
      matchedSymbols: Object.freeze([]),
      blockers: Object.freeze([]),
      executionAuthority: 'NONE',
      automaticPromotionAuthority: false,
      profitabilityClaimAllowed: false,
    });
  }
  try {
    validateArtifactShape(input.artifact, researchCodeSha);
  } catch (error) {
    return Object.freeze({
      schemaVersion: 'forward-observer-scanner-quality-selection-v1',
      status: 'BLOCKED_DATA',
      backtests: Object.freeze({}),
      matchedSymbols: Object.freeze([]),
      blockers: Object.freeze([Object.freeze({
        code: error instanceof Error ? error.message : 'SCANNER_QUALITY_ARTIFACT_INVALID',
        symbol: null,
      })]),
      executionAuthority: 'NONE',
      automaticPromotionAuthority: false,
      profitabilityClaimAllowed: false,
    });
  }

  const blockers: Array<{ code: string; symbol: string | null; details?: Readonly<Record<string, unknown>> }> = [];
  const backtests: Record<string, ScannerBacktestQualitySummary> = {};
  const matchedSymbols: string[] = [];
  const grouped = new Map<string, { symbol: string; cards: ScannerSignalCard[] }>();
  for (const card of input.cards) {
    const symbol = card.symbol.trim().toUpperCase();
    const lookupKey = scannerBacktestLookupKey(card);
    const expectedAssetClass = input.lane.market === 'CRYPTO_FUTURES'
      ? 'coin_futures' : input.lane.market === 'CRYPTO_SPOT' ? 'coin_spot' : 'stock';
    if (!lookupKey || card.assetClass !== expectedAssetClass) {
      blockers.push({
        code: 'SCANNER_QUALITY_DIRECTION_OR_MARKET_NOT_PERMITTED',
        symbol: symbol || null,
      });
      continue;
    }
    const group = grouped.get(lookupKey) ?? { symbol, cards: [] };
    group.cards.push(card);
    grouped.set(lookupKey, group);
  }

  // Group by immutable instrument AND direction for futures. A verified
  // LONG OOS artifact is never indexed under the SHORT candidate's key.
  for (const [lookupKey, { symbol, cards }] of grouped) {
    const directions = [...new Set(cards
      .map(card => normalizeDirection(card.action, input.lane))
      .filter((direction): direction is Exclude<ScannerTradeAction, 'NONE'> => direction !== null))];
    if (directions.length !== 1) {
      blockers.push({ code: 'SCANNER_QUALITY_SYMBOL_DIRECTION_AMBIGUOUS', symbol,
        details: Object.freeze({ directions }) });
      continue;
    }
    const direction = directions[0]!;
    const promotion = expectedPromotionIdentity(input.lane, direction, researchCodeSha);
    if (!promotion) {
      blockers.push({ code: 'SCANNER_QUALITY_PROMOTION_IDENTITY_REQUIRED', symbol, details: Object.freeze({ direction }) });
      continue;
    }
    const matches = input.artifact.entries.filter((entry) =>
      entry.identity.strategyId === promotion.strategyId
      && entry.identity.strategyVersion === promotion.strategyVersion
      && entry.identity.parameterHash === promotion.parameterHash
      && entry.identity.researchCodeSha.toLowerCase() === researchCodeSha
      && entry.identity.market === input.lane.market
      && entry.identity.symbol.toUpperCase() === symbol
      && entry.identity.timeframe === input.lane.timeframe
      && entry.identity.direction === direction);
    if (matches.length !== 1) {
      blockers.push({
        code: matches.length === 0 ? 'SCANNER_QUALITY_EXACT_ENTRY_REQUIRED' : 'SCANNER_QUALITY_EXACT_ENTRY_AMBIGUOUS',
        symbol,
        details: Object.freeze({ direction, matchCount: matches.length }),
      });
      continue;
    }
    const quality = matches[0]!.quality;
    if (!passesMinimumBacktestQuality(quality)) {
      blockers.push({ code: 'SCANNER_QUALITY_MINIMUM_GATE_FAILED', symbol, details: Object.freeze({ direction }) });
      continue;
    }
    backtests[lookupKey] = quality;
    if (!matchedSymbols.includes(symbol)) matchedSymbols.push(symbol);
  }

  const status = matchedSymbols.length === 0
    ? (blockers.length ? 'BLOCKED_DATA' : 'UNAVAILABLE')
    : blockers.length ? 'PARTIAL' : 'READY';
  return Object.freeze({
    schemaVersion: 'forward-observer-scanner-quality-selection-v1',
    status,
    backtests: Object.freeze({ ...backtests }),
    matchedSymbols: Object.freeze([...matchedSymbols].sort()),
    blockers: Object.freeze(blockers.map((blocker) => Object.freeze(blocker))),
    executionAuthority: 'NONE',
    automaticPromotionAuthority: false,
    profitabilityClaimAllowed: false,
  });
}
