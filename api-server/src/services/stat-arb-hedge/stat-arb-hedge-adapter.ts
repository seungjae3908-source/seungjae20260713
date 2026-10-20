import { finalAllowedEntryKrw, projectMarketLedger, requestedEntryExceedsAllowed } from '../trade-automation-risk.service';
import { evaluateHedgeCapability } from './stat-arb-hedge-capabilities';
import {
  DEFAULT_PERFORMANCE_THRESHOLDS, computeHedgeExposure, evaluatePerformanceGate, hedgeClientOrderId,
  hedgeLegIdempotencyKey, hedgePairId, legNotionalKrw, roundDownToStep, slippageBps,
  validateHedgeSignalFreshness, validateHedgeSignalShape, validateLegAgainstRules,
} from './stat-arb-hedge-validation';
import {
  HedgeOrderDisconnectError, HedgeOrderTimeoutError,
  type HedgeAdapterConfig, type HedgeAdapterPorts, type HedgeEnterResult, type HedgeExchangePort,
  type HedgeLegSpec, type HedgeLegState, type HedgeOrderRequest, type HedgeOrderSnapshot, type HedgePairState,
  type HedgeSignal, type HedgeVenue, type PerformanceEvidence,
} from './stat-arb-hedge.types';

/** Owner approval item: flipping this is the LIVE activation the directive forbids in this stage. */
export const LIVE_AUTHORITY_RELEASED = false as const;

/** Upbit KRW spot minimum order (trade-exchange-adapters.service.ts). */
const UPBIT_MIN_ORDER_KRW = 5_000;

/** Pair phases that hold exposure the adapter must not add to. */
export const ENTRY_BLOCKING_PHASES = Object.freeze(['UNBALANCED', 'UNWINDING', 'UNKNOWN', 'LEG1_SUBMITTED', 'LEG1_FILLED', 'LEG2_SUBMITTED', 'EXITING'] as const);
const OPEN_PHASES = new Set(['LEG1_SUBMITTED', 'LEG1_FILLED', 'LEG2_SUBMITTED', 'HEDGED', 'UNBALANCED', 'UNWINDING', 'EXITING', 'UNKNOWN']);
const TERMINAL_LEG = new Set(['FILLED', 'REJECTED', 'CANCELLED', 'TIMEOUT', 'UNKNOWN']);

export const DEFAULT_HEDGE_ADAPTER_CONFIG: Omit<HedgeAdapterConfig, 'userId'> = Object.freeze({
  executionAuthority: 'NONE',
  maxImbalanceBps: 100,
  legFillTimeoutMs: 30_000,
  pollIntervalMs: 1_000,
  maxFxAgeMs: 60_000,
  performanceThresholds: DEFAULT_PERFORMANCE_THRESHOLDS,
});

function blocked(blockCodes: readonly string[], pair: HedgePairState | null, simulated: boolean): HedgeEnterResult {
  return Object.freeze({ accepted: false, pair, blockCodes: Object.freeze([...new Set(blockCodes)]), simulated });
}

function newLeg(spec: HedgeLegSpec, clientOrderId: string, targetQuantity: number): HedgeLegState {
  return {
    legId: spec.legId, role: spec.role, venue: spec.venue, product: spec.product, symbol: spec.symbol, side: spec.side,
    quoteCurrency: spec.quoteCurrency, clientOrderId, exchangeOrderId: null, status: 'PENDING',
    targetQuantity, filledQuantity: 0, averagePrice: null, referencePrice: spec.referencePrice, slippageBps: null,
    feePaid: 0, feeCurrency: spec.quoteCurrency, submittedAtMs: null, firstFillAtMs: null, lastUpdateAtMs: null, rejectReason: null,
  };
}

function applySnapshot(leg: HedgeLegState, snap: HedgeOrderSnapshot, nowMs: number): void {
  leg.exchangeOrderId = snap.exchangeOrderId ?? leg.exchangeOrderId;
  const previousFilled = leg.filledQuantity;
  leg.filledQuantity = Math.max(previousFilled, snap.filledQuantity);
  if (leg.filledQuantity > 0 && previousFilled === 0 && leg.firstFillAtMs == null) leg.firstFillAtMs = nowMs;
  if (snap.averagePrice != null) leg.averagePrice = snap.averagePrice;
  leg.feePaid = Math.max(leg.feePaid, snap.fee);
  leg.feeCurrency = snap.feeCurrency;
  leg.lastUpdateAtMs = nowMs;
  leg.rejectReason = snap.reason ?? leg.rejectReason;
  leg.slippageBps = slippageBps(leg.side, leg.referencePrice, leg.averagePrice);
  switch (snap.status) {
    case 'FILLED': leg.status = 'FILLED'; break;
    case 'PARTIALLY_FILLED': leg.status = 'PARTIALLY_FILLED'; break;
    case 'OPEN': leg.status = leg.filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'SUBMITTED'; break;
    case 'REJECTED': leg.status = leg.filledQuantity > 0 ? 'CANCELLED' : 'REJECTED'; break;
    case 'CANCELLED': leg.status = 'CANCELLED'; break;
    default: leg.status = 'UNKNOWN';
  }
}

export class StatArbHedgeAdapter {
  private readonly config: HedgeAdapterConfig;

  constructor(config: Partial<HedgeAdapterConfig> & Pick<HedgeAdapterConfig, 'userId'>, private readonly ports: HedgeAdapterPorts) {
    this.config = Object.freeze({ ...DEFAULT_HEDGE_ADAPTER_CONFIG, ...config });
  }

  /* ------------------------------ helpers ------------------------------- */

  private now(): number { return this.ports.clock.nowMs(); }

  private port(venue: HedgeVenue): HedgeExchangePort | null { return this.ports.exchanges[venue] ?? null; }

  private async save(pair: HedgePairState, code: string, detail?: string): Promise<void> {
    pair.updatedAtMs = this.now();
    pair.events.push(Object.freeze({ atMs: pair.updatedAtMs, code, ...(detail ? { detail } : {}) }));
    await this.ports.store.save(pair);
  }

  private authorityBlockCodes(venues: readonly HedgeVenue[]): string[] {
    const codes: string[] = [];
    if (this.config.executionAuthority === 'NONE') codes.push('EXECUTION_AUTHORITY_NONE');
    if (this.config.executionAuthority === 'LIVE' && !LIVE_AUTHORITY_RELEASED) codes.push('LIVE_AUTHORITY_NOT_RELEASED');
    for (const venue of venues) {
      const port = this.port(venue);
      if (!port) { codes.push(`VENUE_PORT_MISSING:${venue}`); continue; }
      if (this.config.executionAuthority === 'MOCK' && port.kind !== 'mock') codes.push(`MOCK_AUTHORITY_REFUSES_LIVE_PORT:${venue}`);
      if (this.config.executionAuthority === 'LIVE' && port.kind !== 'live') codes.push(`LIVE_AUTHORITY_REFUSES_MOCK_PORT:${venue}`);
    }
    return codes;
  }

  private isSimulated(): boolean {
    return this.config.executionAuthority !== 'LIVE';
  }

  private async halt(pair: HedgePairState, reason: string, detail: string): Promise<void> {
    pair.phase = 'UNKNOWN';
    pair.haltReason = reason;
    await this.save(pair, reason, detail);
    await this.ports.alerts.send({
      type: 'system_critical', title: 'stat-arb hedge: order state unknown',
      details: `${pair.pairId} ${reason} ${detail}${pair.simulated ? ' [SIMULATED]' : ''}`,
      dedupeKey: `sah:halt:${pair.pairId}:${reason}`,
    });
  }

  /** Submit one leg and drive it to a terminal state (filled / cancelled remainder / rejected / unknown). */
  private async executeLeg(port: HedgeExchangePort, pair: HedgePairState, leg: HedgeLegState, request: HedgeOrderRequest): Promise<void> {
    const submittedAt = this.now();
    leg.submittedAtMs = submittedAt;
    leg.status = 'SUBMITTED';
    await this.save(pair, `LEG_SUBMIT:${leg.legId}`);
    let snap: HedgeOrderSnapshot | null = null;
    try {
      snap = await port.placeOrder(request);
    } catch (error) {
      const timeout = error instanceof HedgeOrderTimeoutError;
      const disconnect = error instanceof HedgeOrderDisconnectError;
      if (!timeout && !disconnect) {
        leg.status = 'REJECTED';
        leg.rejectReason = error instanceof Error ? error.message : String(error);
        leg.lastUpdateAtMs = this.now();
        await this.save(pair, `LEG_REJECTED:${leg.legId}`, leg.rejectReason);
        return;
      }
      // The venue may or may not have accepted the order: ask it, never assume.
      snap = await this.queryQuietly(port, leg);
      if (!snap) {
        await this.ports.clock.sleep(this.config.pollIntervalMs);
        snap = await this.queryQuietly(port, leg);
      }
      if (!snap) {
        leg.status = 'UNKNOWN';
        leg.rejectReason = timeout ? 'TIMEOUT_ORDER_NOT_FOUND' : 'DISCONNECT_ORDER_NOT_FOUND';
        leg.lastUpdateAtMs = this.now();
        await this.save(pair, `LEG_UNKNOWN:${leg.legId}`, leg.rejectReason);
        return;
      }
    }
    applySnapshot(leg, snap, this.now());
    await this.save(pair, `LEG_ACK:${leg.legId}`, leg.status);
    await this.awaitFill(port, pair, leg, submittedAt);
  }

  private async queryQuietly(port: HedgeExchangePort, leg: HedgeLegState): Promise<HedgeOrderSnapshot | null> {
    try { return await port.queryOrder(leg.clientOrderId, leg.symbol); } catch { return null; }
  }

  private async awaitFill(port: HedgeExchangePort, pair: HedgePairState, leg: HedgeLegState, submittedAt: number): Promise<void> {
    while (!TERMINAL_LEG.has(leg.status)) {
      if (this.now() - submittedAt >= this.config.legFillTimeoutMs) {
        let cancel: HedgeOrderSnapshot;
        try { cancel = await port.cancelOrder(leg.clientOrderId, leg.symbol); }
        catch (error) {
          leg.status = 'UNKNOWN';
          leg.rejectReason = `CANCEL_FAILED:${error instanceof Error ? error.message : String(error)}`;
          await this.save(pair, `LEG_UNKNOWN:${leg.legId}`, leg.rejectReason);
          return;
        }
        applySnapshot(leg, cancel, this.now());
        // Cancelled by us after the fill deadline: keep that distinct from a venue-side cancel.
        if (leg.status !== 'FILLED' && leg.status !== 'UNKNOWN') leg.status = 'TIMEOUT';
        await this.save(pair, `LEG_TIMEOUT:${leg.legId}`, `filled=${leg.filledQuantity}`);
        return;
      }
      await this.ports.clock.sleep(this.config.pollIntervalMs);
      const snap = await this.queryQuietly(port, leg);
      if (!snap) {
        leg.status = 'UNKNOWN';
        leg.rejectReason = 'QUERY_FAILED';
        await this.save(pair, `LEG_UNKNOWN:${leg.legId}`, leg.rejectReason);
        return;
      }
      applySnapshot(leg, snap, this.now());
    }
  }

  private refreshExposure(pair: HedgePairState): void {
    pair.exposure = computeHedgeExposure(pair.legs.SPOT, pair.legs.PERP, pair.fxKrwPerUsdt, pair.maxImbalanceBps);
  }

  /* ------------------------------- entry -------------------------------- */

  async enter(signal: HedgeSignal, evidence: PerformanceEvidence | null): Promise<HedgeEnterResult> {
    const simulated = this.isSimulated();
    const shape = validateHedgeSignalShape(signal);
    if (shape.length) return blocked(shape, null, simulated);
    if (signal.action !== 'ENTER') return blocked(['SIGNAL_ACTION_NOT_ENTER'], null, simulated);
    const capability = evaluateHedgeCapability(signal);
    if (!capability.supported || !capability.combination) return blocked(capability.blockCodes, null, simulated);
    const spotSpec = signal.legs.find((l) => l.role === 'SPOT')!;
    const perpSpec = signal.legs.find((l) => l.role === 'PERP')!;
    const codes: string[] = [];
    codes.push(...validateHedgeSignalFreshness(signal, this.now(), this.config.maxFxAgeMs));
    const gate = evaluatePerformanceGate(evidence, signal, this.config.performanceThresholds);
    if (gate.authority !== 'LIVE_ELIGIBLE') codes.push('PERFORMANCE_GATE_FAILED', ...gate.reasons);
    codes.push(...this.authorityBlockCodes([spotSpec.venue, perpSpec.venue]));
    if (codes.length) return blocked(codes, null, simulated);

    const userId = this.config.userId;
    const existing = await this.ports.store.findBySignal(userId, signal.signalId, 'ENTER');
    if (existing) return Object.freeze({ accepted: false, pair: existing, blockCodes: Object.freeze(['DUPLICATE_SIGNAL']), simulated });

    const control = await this.ports.control.read(userId);
    if (control.emergencyStopped) codes.push('EMERGENCY_STOPPED');
    if (control.newEntriesStopped) codes.push('NEW_ENTRIES_STOPPED');
    for (const venue of [spotSpec.venue, perpSpec.venue]) {
      if (!control.canPlaceOrders[venue]) codes.push(`ORDER_PERMISSION_MISSING:${venue}`);
      if (!control.canCancelOrders[venue]) codes.push(`CANCEL_PERMISSION_MISSING:${venue}`);
    }
    if (signal.leverage !== control.policyBitgetLeverage) codes.push('LEVERAGE_POLICY_MISMATCH');

    const openPairs = await this.ports.store.listOpen(userId);
    const blockingPair = openPairs.find((p) => (ENTRY_BLOCKING_PHASES as readonly string[]).includes(p.phase));
    if (blockingPair) {
      codes.push(`HEDGE_IMBALANCE_OPEN:${blockingPair.pairId}:${blockingPair.phase}`);
      await this.ports.alerts.send({
        type: 'risk_block', title: 'stat-arb hedge: entry blocked by open imbalance',
        details: `${blockingPair.pairId} ${blockingPair.phase}`, dedupeKey: `sah:imbalance-block:${blockingPair.pairId}`,
      });
    }
    for (const spec of [spotSpec, perpSpec]) {
      const conflict = await this.ports.conflicts.read(userId, spec.venue, spec.symbol);
      if (conflict.foreignPositionSide || conflict.foreignOpenOrders > 0) {
        codes.push(`STRATEGY_ORDER_CONFLICT:${spec.venue}:${spec.symbol}:${conflict.foreignStrategyIds.join(',') || 'unknown'}`);
      }
    }
    if (codes.length) return blocked(codes, null, simulated);

    const spotPort = this.port(spotSpec.venue)!;
    const perpPort = this.port(perpSpec.venue)!;
    let spotRules; let perpRules;
    try {
      spotRules = await spotPort.instrumentRules(spotSpec.symbol, spotSpec.product);
      perpRules = await perpPort.instrumentRules(perpSpec.symbol, perpSpec.product);
    } catch (error) {
      return blocked([`INSTRUMENT_RULES_UNAVAILABLE:${error instanceof Error ? error.message : String(error)}`], null, simulated);
    }
    codes.push(...validateLegAgainstRules(spotSpec, spotRules), ...validateLegAgainstRules(perpSpec, perpRules));
    const spotQty = roundDownToStep(spotSpec.quantity, spotRules.quantityStep);
    const perpQty = roundDownToStep(perpSpec.quantity, perpRules.quantityStep);
    const spotNotionalKrw = legNotionalKrw({ ...spotSpec, quantity: spotQty }, signal.fx);
    const perpNotionalKrw = legNotionalKrw({ ...perpSpec, quantity: perpQty }, signal.fx);
    if (spotNotionalKrw < UPBIT_MIN_ORDER_KRW) codes.push('SPOT_NOTIONAL_BELOW_UPBIT_MINIMUM');
    const plannedImbalanceBps = Math.abs(spotQty - perpQty) / Math.max(spotQty, perpQty, 1e-12) * 10_000;
    if (plannedImbalanceBps > this.config.maxImbalanceBps) codes.push('PLANNED_LEGS_NOT_HEDGE_NEUTRAL');
    const notionalGapBps = Math.abs(spotNotionalKrw - perpNotionalKrw) / Math.max(spotNotionalKrw, 1) * 10_000;
    if (notionalGapBps > 300) codes.push('LEG_REFERENCE_PRICES_DIVERGE');
    if (codes.length) return blocked(codes, null, simulated);

    // Existing safeguards: per-market ledger projection + strictest-limit entry size.
    let spotAvailableKrw: number; let perpAvailableUsdt: number;
    try {
      spotAvailableKrw = await spotPort.readAvailable('KRW');
      perpAvailableUsdt = await perpPort.readAvailable('USDT');
    } catch (error) {
      return blocked([`BALANCE_READ_FAILED:${error instanceof Error ? error.message : String(error)}`], null, simulated);
    }
    const ledger = await this.ports.ledger.read(userId);
    const perpMarginKrw = perpNotionalKrw / signal.leverage;
    const checks: Array<['crypto_spot' | 'crypto_futures', number, number, number | null]> = [
      ['crypto_spot', spotNotionalKrw, spotAvailableKrw, UPBIT_MIN_ORDER_KRW],
      ['crypto_futures', perpMarginKrw, perpAvailableUsdt * signal.fx.krwPerUsdt, perpRules.minNotional * signal.fx.krwPerUsdt / signal.leverage],
    ];
    for (const [market, requestedKrw, exchangeAvailableKrw, minimumKrw] of checks) {
      const projection = projectMarketLedger({ ...ledger[market], market, exchangeAvailableKrw });
      codes.push(...projection.blockCodes.map((c) => `${c}:${market}`));
      const allowed = finalAllowedEntryKrw({
        roleCapKrw: control.roleCapKrw, policyMaxOrderKrw: control.policyMaxOrderKrw,
        marketAllocatedKrw: projection.allocatedKrw, ledgerAvailableKrw: projection.availableKrw,
        exchangeAvailableKrw, exchangeMinimumKrw: minimumKrw, exchangeMaximumKrw: null,
      });
      codes.push(...allowed.blockCodes.map((c) => `${c}:${market}`));
      if (requestedEntryExceedsAllowed(requestedKrw, allowed)) codes.push(`ENTRY_EXCEEDS_ALLOWED:${market}:${allowed.bindingLimit}`);
    }
    if (spotAvailableKrw < spotNotionalKrw) codes.push('INSUFFICIENT_BALANCE:upbit');
    if (perpAvailableUsdt * signal.fx.krwPerUsdt < perpMarginKrw) codes.push('INSUFFICIENT_BALANCE:bitget');

    // Position mismatch: the perp venue must hold exactly what our open pairs say.
    let perpPosition;
    try { perpPosition = await perpPort.readPosition(perpSpec.symbol, perpSpec.product); }
    catch (error) { return blocked([`POSITION_READ_FAILED:${error instanceof Error ? error.message : String(error)}`], null, simulated); }
    const expectedShort = openPairs.filter((p) => p.legs.PERP.symbol === perpSpec.symbol)
      .reduce((sum, p) => sum + p.legs.PERP.filledQuantity - (p.exitLegs?.PERP.filledQuantity ?? 0), 0);
    const venueShort = perpPosition.side === 'short' ? perpPosition.quantity : perpPosition.side === 'long' ? -perpPosition.quantity : 0;
    if (Math.abs(venueShort - expectedShort) > Math.max(perpRules.quantityStep, 1e-9)) codes.push('POSITION_MISMATCH:bitget');
    if (perpPosition.side === 'long' && perpPosition.quantity > 0) codes.push('OPPOSITE_POSITION_OPEN:bitget');
    if (codes.length) return blocked(codes, null, simulated);

    const pair: HedgePairState = {
      pairId: hedgePairId(userId, signal), userId, strategyId: signal.strategyId, strategyVersion: signal.strategyVersion,
      researchCodeSha: signal.researchCodeSha, entrySignalId: signal.signalId, exitSignalId: null, simulated,
      phase: 'PLANNED',
      legs: {
        SPOT: newLeg(spotSpec, hedgeClientOrderId(spotSpec.venue, hedgeLegIdempotencyKey(userId, signal, spotSpec.legId)), spotQty),
        PERP: newLeg(perpSpec, hedgeClientOrderId(perpSpec.venue, hedgeLegIdempotencyKey(userId, signal, perpSpec.legId)), perpQty),
      },
      exitLegs: null, leverage: signal.leverage, fxKrwPerUsdt: signal.fx.krwPerUsdt, maxImbalanceBps: this.config.maxImbalanceBps,
      exposure: computeHedgeExposure({ filledQuantity: 0, averagePrice: null, referencePrice: spotSpec.referencePrice },
        { filledQuantity: 0, averagePrice: null, referencePrice: perpSpec.referencePrice }, signal.fx.krwPerUsdt, this.config.maxImbalanceBps),
      fundingPaidUsdt: null, fundingStatus: 'NOT_AVAILABLE_LIVE', realizedPnlKrw: null, unrealizedPnlKrw: null,
      blockCodes: [], haltReason: null, events: [], createdAtMs: this.now(), updatedAtMs: this.now(),
    };
    await this.save(pair, 'PAIR_PLANNED', `gate=${gate.matchedRows.map((r) => r.window).join('+')}`);

    // Leg 1: SPOT buy (cannot be shorted; sized first so the perp hedge matches what actually filled).
    pair.phase = 'LEG1_SUBMITTED';
    const spot = pair.legs.SPOT;
    await this.executeLeg(spotPort, pair, spot, {
      clientOrderId: spot.clientOrderId, venue: spot.venue, product: spot.product, symbol: spot.symbol, side: spot.side,
      quantity: spot.targetQuantity, priceType: spotSpec.priceType, limitPrice: spotSpec.limitPrice ?? null,
    });
    this.refreshExposure(pair);
    if (spot.status === 'UNKNOWN') { await this.halt(pair, 'ORDER_STATE_UNKNOWN', `leg=${spot.legId}`); return blocked(['ORDER_STATE_UNKNOWN'], pair, simulated); }
    if (spot.filledQuantity <= 0) {
      pair.phase = 'REJECTED';
      await this.save(pair, 'PAIR_REJECTED', `spot ${spot.status} ${spot.rejectReason ?? ''}`);
      return blocked([`LEG1_${spot.status}`], pair, simulated);
    }
    pair.phase = 'LEG1_FILLED';
    await this.save(pair, 'LEG1_FILLED', `filled=${spot.filledQuantity}/${spot.targetQuantity}`);

    // Leg 2: PERP short sized to the spot fill, rounded DOWN to the contract step.
    const perp = pair.legs.PERP;
    perp.targetQuantity = roundDownToStep(spot.filledQuantity, perpRules.quantityStep);
    if (perp.targetQuantity < perpRules.minQuantity || perp.targetQuantity * perpSpec.referencePrice < perpRules.minNotional) {
      await this.save(pair, 'LEG2_BELOW_MINIMUM', `hedge=${perp.targetQuantity}`);
      await this.unwindSpot(spotPort, pair, 'LEG2_BELOW_MINIMUM');
      return blocked(['LEG2_BELOW_MINIMUM'], pair, simulated);
    }
    pair.phase = 'LEG2_SUBMITTED';
    await this.executeLeg(perpPort, pair, perp, {
      clientOrderId: perp.clientOrderId, venue: perp.venue, product: perp.product, symbol: perp.symbol, side: perp.side,
      quantity: perp.targetQuantity, priceType: perpSpec.priceType, limitPrice: perpSpec.limitPrice ?? null,
      leverage: signal.leverage, marginMode: 'isolated', reduceOnly: false,
    });
    this.refreshExposure(pair);
    if (perp.status === 'UNKNOWN') { await this.halt(pair, 'ORDER_STATE_UNKNOWN', `leg=${perp.legId}`); return blocked(['ORDER_STATE_UNKNOWN'], pair, simulated); }
    if (perp.filledQuantity <= 0) {
      await this.save(pair, 'LEG2_FAILED', `${perp.status} ${perp.rejectReason ?? ''}`);
      await this.unwindSpot(spotPort, pair, `LEG2_${perp.status}`);
      return blocked([`LEG2_${perp.status}`], pair, simulated);
    }
    if (pair.exposure.balanced) {
      pair.phase = 'HEDGED';
      await this.save(pair, 'PAIR_HEDGED', `spot=${spot.filledQuantity} perp=${perp.filledQuantity}`);
      return Object.freeze({ accepted: true, pair, blockCodes: Object.freeze([]), simulated });
    }
    pair.phase = 'UNBALANCED';
    await this.save(pair, 'PAIR_UNBALANCED', `imbalance=${pair.exposure.imbalanceQuantity} (${pair.exposure.imbalanceBps.toFixed(1)}bps)`);
    await this.ports.alerts.send({
      type: 'risk_block', title: 'stat-arb hedge: legs unbalanced',
      details: `${pair.pairId} spot=${spot.filledQuantity} perp=${perp.filledQuantity}${simulated ? ' [SIMULATED]' : ''}`,
      dedupeKey: `sah:unbalanced:${pair.pairId}`,
    });
    return blocked(['HEDGE_UNBALANCED'], pair, simulated);
  }

  /** Sell back whatever spot filled when the perp leg could not hedge it. */
  private async unwindSpot(spotPort: HedgeExchangePort, pair: HedgePairState, reason: string): Promise<void> {
    const spot = pair.legs.SPOT;
    pair.phase = 'UNWINDING';
    await this.save(pair, 'UNWIND_START', reason);
    const unwind = newLeg(
      { legId: `${spot.legId}-unwind`, role: 'SPOT', venue: spot.venue, product: spot.product, symbol: spot.symbol, side: 'sell',
        quantity: spot.filledQuantity, priceType: 'market', referencePrice: spot.averagePrice ?? spot.referencePrice, quoteCurrency: spot.quoteCurrency },
      `${spot.clientOrderId}-u`, spot.filledQuantity,
    );
    pair.exitLegs = { SPOT: unwind, PERP: { ...newLeg({ ...pair.legs.PERP, legId: `${pair.legs.PERP.legId}-unwind`, side: 'long', quantity: 0, priceType: 'market' }, `${pair.legs.PERP.clientOrderId}-u`, 0), status: 'FILLED' } };
    await this.executeLeg(spotPort, pair, unwind, {
      clientOrderId: unwind.clientOrderId, venue: unwind.venue, product: unwind.product, symbol: unwind.symbol,
      side: 'sell', quantity: unwind.targetQuantity, priceType: 'market',
    });
    if (unwind.status === 'FILLED' && Math.abs(unwind.filledQuantity - spot.filledQuantity) < 1e-9) {
      pair.phase = 'UNWOUND';
      pair.realizedPnlKrw = (unwind.averagePrice ?? 0) * unwind.filledQuantity - (spot.averagePrice ?? 0) * spot.filledQuantity - spot.feePaid - unwind.feePaid;
      await this.save(pair, 'UNWOUND', `pnlKrw=${pair.realizedPnlKrw.toFixed(0)}`);
      return;
    }
    if (unwind.status === 'UNKNOWN') { await this.halt(pair, 'ORDER_STATE_UNKNOWN', `leg=${unwind.legId}`); return; }
    pair.phase = 'UNBALANCED';
    await this.save(pair, 'UNWIND_INCOMPLETE', `${unwind.status} filled=${unwind.filledQuantity}`);
    await this.ports.alerts.send({
      type: 'risk_block', title: 'stat-arb hedge: naked spot after failed unwind',
      details: `${pair.pairId} remaining=${spot.filledQuantity - unwind.filledQuantity}${pair.simulated ? ' [SIMULATED]' : ''}`,
      dedupeKey: `sah:unwind-failed:${pair.pairId}`,
    });
  }

  /* -------------------------------- exit -------------------------------- */

  async exit(signal: HedgeSignal): Promise<HedgeEnterResult> {
    const simulated = this.isSimulated();
    const shape = validateHedgeSignalShape(signal);
    if (shape.length) return blocked(shape, null, simulated);
    if (signal.action !== 'EXIT') return blocked(['SIGNAL_ACTION_NOT_EXIT'], null, simulated);
    const capability = evaluateHedgeCapability(signal);
    if (!capability.supported) return blocked(capability.blockCodes, null, simulated);
    const spotSpec = signal.legs.find((l) => l.role === 'SPOT')!;
    const perpSpec = signal.legs.find((l) => l.role === 'PERP')!;
    const codes = [...validateHedgeSignalFreshness(signal, this.now(), this.config.maxFxAgeMs), ...this.authorityBlockCodes([spotSpec.venue, perpSpec.venue])];
    if (codes.length) return blocked(codes, null, simulated);
    const userId = this.config.userId;
    const duplicate = await this.ports.store.findBySignal(userId, signal.signalId, 'EXIT');
    if (duplicate) return Object.freeze({ accepted: false, pair: duplicate, blockCodes: Object.freeze(['DUPLICATE_SIGNAL']), simulated });
    const pair = await this.ports.store.load(String(signal.pairId));
    if (!pair || pair.userId !== userId) return blocked(['PAIR_NOT_FOUND'], null, simulated);
    if (pair.phase !== 'HEDGED' && pair.phase !== 'UNBALANCED') return blocked([`PAIR_NOT_EXITABLE:${pair.phase}`], pair, simulated);
    if (pair.legs.SPOT.symbol !== spotSpec.symbol || pair.legs.PERP.symbol !== perpSpec.symbol) return blocked(['EXIT_SYMBOL_MISMATCH'], pair, simulated);
    const control = await this.ports.control.read(userId);
    // Exits reduce risk: an emergency stop or new-entries stop never blocks them, missing permissions do.
    for (const venue of [spotSpec.venue, perpSpec.venue]) {
      if (!control.canPlaceOrders[venue]) codes.push(`ORDER_PERMISSION_MISSING:${venue}`);
      if (!control.canCancelOrders[venue]) codes.push(`CANCEL_PERMISSION_MISSING:${venue}`);
    }
    if (codes.length) return blocked(codes, pair, simulated);
    const spotPort = this.port(spotSpec.venue)!;
    const perpPort = this.port(perpSpec.venue)!;

    const previousPhase = pair.phase;
    pair.exitSignalId = signal.signalId;
    const perpQty = pair.legs.PERP.filledQuantity - (pair.exitLegs?.PERP.filledQuantity ?? 0);
    const spotQty = pair.legs.SPOT.filledQuantity - (pair.exitLegs?.SPOT.filledQuantity ?? 0);
    const exitPerp = newLeg({ ...perpSpec, quantity: perpQty }, hedgeClientOrderId(perpSpec.venue, hedgeLegIdempotencyKey(userId, signal, perpSpec.legId)), perpQty);
    const exitSpot = newLeg({ ...spotSpec, quantity: spotQty }, hedgeClientOrderId(spotSpec.venue, hedgeLegIdempotencyKey(userId, signal, spotSpec.legId)), spotQty);
    pair.exitLegs = { SPOT: exitSpot, PERP: exitPerp };
    pair.phase = 'EXITING';
    await this.save(pair, 'EXIT_START', signal.signalId);

    // Close the leveraged leg first (liquidation risk), then the spot leg.
    if (perpQty > 0) {
      await this.executeLeg(perpPort, pair, exitPerp, {
        clientOrderId: exitPerp.clientOrderId, venue: exitPerp.venue, product: exitPerp.product, symbol: exitPerp.symbol,
        side: 'long', quantity: perpQty, priceType: perpSpec.priceType, limitPrice: perpSpec.limitPrice ?? null, reduceOnly: true,
        leverage: pair.leverage, marginMode: 'isolated',
      });
      if (exitPerp.status === 'UNKNOWN') { await this.halt(pair, 'ORDER_STATE_UNKNOWN', `leg=${exitPerp.legId}`); return blocked(['ORDER_STATE_UNKNOWN'], pair, simulated); }
      if (exitPerp.filledQuantity < perpQty - 1e-9) {
        // Perp not (fully) closed: keep the hedge, do not touch the spot leg.
        pair.phase = exitPerp.filledQuantity > 0 ? 'UNBALANCED' : previousPhase;
        await this.save(pair, 'EXIT_PERP_FAILED', `${exitPerp.status} filled=${exitPerp.filledQuantity}/${perpQty}`);
        await this.ports.alerts.send({
          type: 'risk_block', title: 'stat-arb hedge: exit perp leg failed', details: `${pair.pairId} ${exitPerp.status}${simulated ? ' [SIMULATED]' : ''}`,
          dedupeKey: `sah:exit-perp-failed:${pair.pairId}:${signal.signalId}`,
        });
        return blocked([`EXIT_PERP_${exitPerp.status}`], pair, simulated);
      }
    } else { exitPerp.status = 'FILLED'; }
    if (spotQty > 0) {
      await this.executeLeg(spotPort, pair, exitSpot, {
        clientOrderId: exitSpot.clientOrderId, venue: exitSpot.venue, product: exitSpot.product, symbol: exitSpot.symbol,
        side: 'sell', quantity: spotQty, priceType: spotSpec.priceType, limitPrice: spotSpec.limitPrice ?? null,
      });
      if (exitSpot.status === 'UNKNOWN') { await this.halt(pair, 'ORDER_STATE_UNKNOWN', `leg=${exitSpot.legId}`); return blocked(['ORDER_STATE_UNKNOWN'], pair, simulated); }
      if (exitSpot.filledQuantity < spotQty - 1e-9) {
        pair.phase = 'UNBALANCED';
        await this.save(pair, 'EXIT_SPOT_FAILED', `${exitSpot.status} filled=${exitSpot.filledQuantity}/${spotQty}`);
        await this.ports.alerts.send({
          type: 'risk_block', title: 'stat-arb hedge: naked spot after perp close', details: `${pair.pairId} remaining=${spotQty - exitSpot.filledQuantity}${simulated ? ' [SIMULATED]' : ''}`,
          dedupeKey: `sah:exit-spot-failed:${pair.pairId}:${signal.signalId}`,
        });
        return blocked([`EXIT_SPOT_${exitSpot.status}`], pair, simulated);
      }
    } else { exitSpot.status = 'FILLED'; }

    await this.settle(pair, perpPort, signal.fx.krwPerUsdt);
    pair.phase = 'CLOSED';
    await this.save(pair, 'PAIR_CLOSED', `pnlKrw=${pair.realizedPnlKrw?.toFixed(0) ?? 'null'} funding=${pair.fundingStatus}`);
    return Object.freeze({ accepted: true, pair, blockCodes: Object.freeze([]), simulated });
  }

  private async settle(pair: HedgePairState, perpPort: HedgeExchangePort, exitFx: number): Promise<void> {
    const { SPOT: spot, PERP: perp } = pair.legs;
    const { SPOT: exitSpot, PERP: exitPerp } = pair.exitLegs!;
    const spotPnlKrw = (exitSpot.averagePrice ?? 0) * exitSpot.filledQuantity - (spot.averagePrice ?? 0) * spot.filledQuantity - spot.feePaid - exitSpot.feePaid;
    const perpPnlUsdt = ((perp.averagePrice ?? 0) - (exitPerp.averagePrice ?? 0)) * exitPerp.filledQuantity - perp.feePaid - exitPerp.feePaid;
    let fundingUsdt: number | null = null;
    if (perpPort.readFundingPaidUsdt) {
      try { fundingUsdt = await perpPort.readFundingPaidUsdt(perp.symbol, perp.submittedAtMs ?? pair.createdAtMs); } catch { fundingUsdt = null; }
    }
    pair.fundingPaidUsdt = fundingUsdt;
    pair.fundingStatus = fundingUsdt == null ? 'NOT_AVAILABLE_LIVE' : 'REPORTED';
    pair.realizedPnlKrw = spotPnlKrw + (perpPnlUsdt + (fundingUsdt ?? 0)) * exitFx;
    pair.unrealizedPnlKrw = 0;
    this.refreshExposure(pair);
  }

  /* ------------------------------ recovery ------------------------------ */

  /** After a restart: re-read every non-terminal leg by clientOrderId and the
   * perp position, then settle the phase. Places no orders. */
  async recover(pairId: string): Promise<HedgePairState | null> {
    const pair = await this.ports.store.load(pairId);
    if (!pair || pair.userId !== this.config.userId) return null;
    if (!OPEN_PHASES.has(pair.phase)) return pair;
    const legs: HedgeLegState[] = [pair.legs.SPOT, pair.legs.PERP, ...(pair.exitLegs ? [pair.exitLegs.PERP, pair.exitLegs.SPOT] : [])];
    let unknown = false;
    for (const leg of legs) {
      if (leg.status === 'PENDING' || leg.status === 'FILLED' || leg.status === 'REJECTED' || leg.status === 'CANCELLED') continue;
      const port = this.port(leg.venue);
      if (!port) { unknown = true; continue; }
      let snap: HedgeOrderSnapshot | null;
      try { snap = await port.queryOrder(leg.clientOrderId, leg.symbol); }
      catch { unknown = true; continue; }
      if (!snap) {
        // The venue has never seen this clientOrderId: the submit never landed.
        // The position reconciliation below still has to agree before we trust it.
        leg.status = 'REJECTED';
        leg.rejectReason = 'NOT_FOUND_ON_RECOVERY';
        leg.lastUpdateAtMs = this.now();
        continue;
      }
      if (snap.status === 'UNKNOWN') { unknown = true; continue; }
      applySnapshot(leg, snap, this.now());
      if (snap.status === 'OPEN' || snap.status === 'PARTIALLY_FILLED') {
        // Still working at the venue: cancel the remainder rather than leave an orphan.
        try { applySnapshot(leg, await port.cancelOrder(leg.clientOrderId, leg.symbol), this.now()); }
        catch { unknown = true; }
        if (leg.status === 'SUBMITTED' || leg.status === 'PARTIALLY_FILLED') leg.status = 'TIMEOUT';
      }
    }
    this.refreshExposure(pair);
    const perpPort = this.port(pair.legs.PERP.venue);
    if (perpPort) {
      try {
        const position = await perpPort.readPosition(pair.legs.PERP.symbol, pair.legs.PERP.product);
        const expected = pair.legs.PERP.filledQuantity - (pair.exitLegs?.PERP.filledQuantity ?? 0);
        const venueShort = position.side === 'short' ? position.quantity : 0;
        if (Math.abs(venueShort - expected) > 1e-9) { unknown = true; pair.blockCodes.push('RECOVERY_POSITION_MISMATCH'); }
      } catch { unknown = true; }
    } else { unknown = true; }
    if (unknown) { await this.halt(pair, 'RECOVERY_RECONCILIATION_FAILED', 'leg or position state could not be confirmed'); return pair; }
    pair.haltReason = null;
    if (pair.exitLegs && pair.phase === 'EXITING') {
      const perpDone = pair.exitLegs.PERP.filledQuantity >= pair.legs.PERP.filledQuantity - 1e-9;
      const spotDone = pair.exitLegs.SPOT.filledQuantity >= pair.legs.SPOT.filledQuantity - 1e-9;
      if (perpDone && spotDone) { await this.settle(pair, perpPort!, pair.fxKrwPerUsdt); pair.phase = 'CLOSED'; }
      else pair.phase = perpDone || pair.exitLegs.PERP.filledQuantity > 0 ? 'UNBALANCED' : 'HEDGED';
      await this.save(pair, 'RECOVERED', pair.phase);
      return pair;
    }
    if (pair.phase === 'UNWINDING' && pair.exitLegs) {
      pair.phase = pair.exitLegs.SPOT.filledQuantity >= pair.legs.SPOT.filledQuantity - 1e-9 ? 'UNWOUND' : 'UNBALANCED';
      await this.save(pair, 'RECOVERED', pair.phase);
      return pair;
    }
    const spotFilled = pair.legs.SPOT.filledQuantity;
    const perpFilled = pair.legs.PERP.filledQuantity;
    if (spotFilled <= 0 && perpFilled <= 0) pair.phase = 'REJECTED';
    else if (pair.exposure.balanced) pair.phase = 'HEDGED';
    else pair.phase = 'UNBALANCED';
    await this.save(pair, 'RECOVERED', pair.phase);
    if (pair.phase === 'UNBALANCED') {
      await this.ports.alerts.send({
        type: 'risk_block', title: 'stat-arb hedge: unbalanced after recovery',
        details: `${pair.pairId} spot=${spotFilled} perp=${perpFilled}${pair.simulated ? ' [SIMULATED]' : ''}`, dedupeKey: `sah:recovered-unbalanced:${pair.pairId}`,
      });
    }
    return pair;
  }
}
