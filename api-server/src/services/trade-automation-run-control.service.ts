import { randomUUID } from 'node:crypto';
import {
  DEFAULT_AUTO_RUN_CONTROL,
  normalizeAutoRunControl,
  type TradingRepository,
} from './trade-automation.repository';
import type {
  AutoRunAction,
  AutoRunAuditEntry,
  AutoRunControl,
  TradingAssetClass,
  TradingExchange,
  TradingPolicy,
} from './trade-automation.types';

/**
 * 작동/정지 (run/stop) control for member automatic trading.
 *
 * Owner decision 2026-10-17: automatic trading does not ask for approval per
 * order. While the member's run state is ON, eligible signals of the member's
 * enabled strategies are executed automatically; while it is OFF nothing is
 * placed. Run state is the persisted policy itself
 * (mode=automatic && automaticEnabled && no member stop), so the worker and
 * the execution service enforce it on every order without a second source of
 * truth. Every risk guard stays independent of the run state:
 * - Paper vs LIVE per market is decided only by the server gates (#1923
 *   per-market live scope + provider automatic gates). Pressing 작동 never
 *   turns a Paper market into a LIVE market.
 * - Daily loss limits block orders and auto-stop the run (new entries only;
 *   protective exits of owned positions keep running).
 * - Per-symbol/asset weight, idempotency and kill switches are unchanged.
 */

export const AUTO_RUN_ASSET_CLASSES: readonly TradingAssetClass[] = Object.freeze([
  'domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures',
]);

/** Loss-limit block codes that auto-stop a running member. */
export const AUTO_RUN_LOSS_STOP_CODES: ReadonlySet<string> = new Set([
  'DAILY_LOSS_LIMIT',
  'TOTAL_DAILY_LOSS_BUDGET',
]);

export type AutoRunLane = 'live' | 'paper';
export type AutoRunMarketLane = { enabled: boolean; exchange: TradingExchange; lane: AutoRunLane };
export type AutoRunMarketLanes = Record<TradingAssetClass, AutoRunMarketLane>;
/** Server-only decision: is this market/provider open for automatic LIVE entries? */
export type AutoRunLiveResolver = (assetClass: TradingAssetClass, exchange: TradingExchange) => boolean;

let registeredLiveResolver: AutoRunLiveResolver | null = null;
/** The HTTP layer registers the server gate resolver so system auto-stops can label lanes. */
export function registerAutoRunLiveResolver(resolver: AutoRunLiveResolver | null) {
  registeredLiveResolver = resolver;
}

export function autoRunMarketProvider(policy: TradingPolicy, assetClass: TradingAssetClass): TradingExchange {
  if (assetClass === 'crypto_spot') return 'upbit';
  if (assetClass === 'crypto_futures') return 'bitget';
  if (assetClass === 'us_stock') return 'kiwoom';
  return policy.stockBrokerByMarket?.domestic_stock === 'toss' ? 'toss' : 'kiwoom';
}

export function autoRunMarketLanes(policy: TradingPolicy, isLive: AutoRunLiveResolver): AutoRunMarketLanes {
  return Object.fromEntries(AUTO_RUN_ASSET_CLASSES.map((assetClass) => {
    const exchange = autoRunMarketProvider(policy, assetClass);
    const enabled = policy.marketEnabled[assetClass] === true && policy.exchangeEnabled[exchange] === true;
    return [assetClass, { enabled, exchange, lane: isLive(assetClass, exchange) ? 'live' : 'paper' }];
  })) as AutoRunMarketLanes;
}

function enabledMarketsByLane(lanes: AutoRunMarketLanes) {
  const live: TradingAssetClass[] = [];
  const paper: TradingAssetClass[] = [];
  for (const assetClass of AUTO_RUN_ASSET_CLASSES) {
    const row = lanes[assetClass];
    if (!row.enabled) continue;
    (row.lane === 'live' ? live : paper).push(assetClass);
  }
  return { live, paper };
}

/** The member's run switch is ON (independent of the server-wide stop). */
export function autoRunSwitchOn(policy: TradingPolicy) {
  return policy.mode === 'automatic'
    && policy.automaticEnabled
    && !policy.emergencyStopped
    && !policy.newEntriesStopped;
}

export type AutoRunState = 'RUNNING' | 'STOPPED' | 'AUTO_STOPPED' | 'KILL_SWITCH' | 'GLOBAL_STOP';

export function autoRunState(policy: TradingPolicy, control: AutoRunControl, globalStopped: boolean): AutoRunState {
  if (policy.emergencyStopped) return 'KILL_SWITCH';
  if (policy.newEntriesStopped) return control.lastAction === 'AUTO_STOP' ? 'AUTO_STOPPED' : 'KILL_SWITCH';
  if (!autoRunSwitchOn(policy)) return control.lastAction === 'AUTO_STOP' ? 'AUTO_STOPPED' : 'STOPPED';
  return globalStopped ? 'GLOBAL_STOP' : 'RUNNING';
}

export async function readAutoRunControl(repository: TradingRepository, userId: string) {
  if (!repository.getRunControl) return { control: normalizeAutoRunControl(DEFAULT_AUTO_RUN_CONTROL), storageReady: false };
  try {
    return { control: await repository.getRunControl(userId), storageReady: true };
  } catch {
    return { control: normalizeAutoRunControl(DEFAULT_AUTO_RUN_CONTROL), storageReady: false };
  }
}

export async function readAutoRunAudit(repository: TradingRepository, userId: string, limit = 10) {
  if (!repository.listRunAudit) return { entries: [] as AutoRunAuditEntry[], storageReady: false };
  try {
    return { entries: await repository.listRunAudit(userId, limit), storageReady: true };
  } catch {
    return { entries: [] as AutoRunAuditEntry[], storageReady: false };
  }
}

export type AutoRunAuditResult = { auditRecorded: true; auditStorage: 'DATABASE' | 'SERVER_LOG' };

/**
 * Persist the run record and append one audit row. The audit always lands
 * server side: the database table when it is available, otherwise a
 * structured server log line (never silently dropped).
 */
async function recordAutoRunChange(repository: TradingRepository, input: {
  userId: string;
  action: AutoRunAction;
  reason: string | null;
  actor: 'member' | 'system';
  lanes: AutoRunMarketLanes | null;
  control: AutoRunControl;
  now: Date;
}): Promise<AutoRunAuditResult> {
  const createdAt = input.now.toISOString();
  const markets = input.lanes ? enabledMarketsByLane(input.lanes) : { live: [], paper: [] };
  const control: AutoRunControl = normalizeAutoRunControl({
    ...input.control,
    lastAction: input.action,
    lastReason: input.reason,
    changedAt: createdAt,
  });
  try { await repository.saveRunControl?.(input.userId, control); } catch { /* audit below still records the change */ }
  const entry: AutoRunAuditEntry = {
    id: randomUUID(),
    userId: input.userId,
    action: input.action,
    reason: input.reason,
    actor: input.actor,
    liveMarkets: markets.live,
    paperMarkets: markets.paper,
    createdAt,
  };
  if (repository.appendRunAudit) {
    try {
      await repository.appendRunAudit(entry);
      return { auditRecorded: true, auditStorage: 'DATABASE' };
    } catch { /* fall through to the server log */ }
  }
  console.info('[trade-automation-run-audit]', JSON.stringify(entry));
  return { auditRecorded: true, auditStorage: 'SERVER_LOG' };
}

export type StartAutoRunResult =
  | {
    ok: true;
    policy: TradingPolicy;
    control: AutoRunControl;
    liveMarkets: TradingAssetClass[];
    paperMarkets: TradingAssetClass[];
    alreadyRunning: boolean;
  } & Partial<AutoRunAuditResult>
  | { ok: false; status: number; error: string; liveMarkets?: TradingAssetClass[] };

export async function startAutoRun(repository: TradingRepository, userId: string, input: {
  isLive: AutoRunLiveResolver;
  liveConfirmed: boolean;
  now?: Date;
}): Promise<StartAutoRunResult> {
  const now = input.now ?? new Date();
  const [current, persistentGlobalStop, { control }] = await Promise.all([
    repository.getPolicy(userId),
    repository.getGlobalEmergencyStop(),
    readAutoRunControl(repository, userId),
  ]);
  if (persistentGlobalStop || process.env.TRADING_EMERGENCY_STOP === 'true') {
    return { ok: false, status: 409, error: 'GLOBAL_EMERGENCY_STOP_ACTIVE' };
  }
  // A daily-loss auto-stop may be restarted by the member pressing 작동 again;
  // the loss limit is still re-checked on every order. A kill switch needs the
  // dedicated confirmed resume first.
  const resumableAutoStop = current.newEntriesStopped && !current.emergencyStopped && control.lastAction === 'AUTO_STOP';
  if (current.emergencyStopped || (current.newEntriesStopped && !resumableAutoStop)) {
    return { ok: false, status: 409, error: 'MEMBER_TRADING_RESUME_REQUIRED' };
  }
  const lanes = autoRunMarketLanes(current, input.isLive);
  const { live, paper } = enabledMarketsByLane(lanes);
  if (live.length + paper.length === 0) return { ok: false, status: 409, error: 'AUTO_RUN_MARKET_REQUIRED' };
  const unconfirmedLive = live.filter((market) => !control.liveConfirmedMarkets.includes(market));
  if (unconfirmedLive.length > 0 && !input.liveConfirmed) {
    return { ok: false, status: 409, error: 'AUTO_RUN_LIVE_CONFIRMATION_REQUIRED', liveMarkets: unconfirmedLive };
  }
  const alreadyRunning = autoRunSwitchOn(current);
  const nextControl = normalizeAutoRunControl({
    ...control,
    liveConfirmedMarkets: [...control.liveConfirmedMarkets, ...unconfirmedLive],
  });
  if (alreadyRunning && unconfirmedLive.length === 0) {
    return { ok: true, policy: current, control: nextControl, liveMarkets: live, paperMarkets: paper, alreadyRunning: true };
  }
  const policy: TradingPolicy = {
    ...current,
    mode: 'automatic',
    automaticEnabled: true,
    newEntriesStopped: resumableAutoStop ? false : current.newEntriesStopped,
  };
  await repository.savePolicy(userId, policy);
  const audit = await recordAutoRunChange(repository, {
    userId, action: 'RUN', reason: resumableAutoStop ? 'RESTART_AFTER_AUTO_STOP' : null,
    actor: 'member', lanes, control: nextControl, now,
  });
  return {
    ok: true, policy, control: { ...nextControl, lastAction: 'RUN', changedAt: now.toISOString() },
    liveMarkets: live, paperMarkets: paper, alreadyRunning, ...audit,
  };
}

export async function stopAutoRun(repository: TradingRepository, userId: string, input: {
  isLive: AutoRunLiveResolver;
  reason?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const [current, { control }] = await Promise.all([
    repository.getPolicy(userId),
    readAutoRunControl(repository, userId),
  ]);
  const lanes = autoRunMarketLanes(current, input.isLive);
  const wasRunning = autoRunSwitchOn(current);
  // 정지 = nothing is placed: the automatic switch goes OFF. Market choices
  // are kept so the next 작동 resumes the same markets.
  const policy: TradingPolicy = { ...current, automaticEnabled: false };
  if (current.automaticEnabled) await repository.savePolicy(userId, policy);
  const audit = await recordAutoRunChange(repository, {
    userId, action: 'STOP', reason: input.reason ?? 'MEMBER_STOP', actor: 'member', lanes, control, now,
  });
  return { policy, wasRunning, ...audit };
}

/**
 * Audit a run switch change made through the settings save (PUT /policy).
 * That save already requires the standing-authorization acknowledgement, so
 * the LIVE markets it turns on count as acknowledged.
 */
export async function recordAutoRunPolicyToggle(repository: TradingRepository, userId: string, input: {
  before: TradingPolicy;
  after: TradingPolicy;
  isLive: AutoRunLiveResolver;
  now?: Date;
}): Promise<AutoRunAuditResult | null> {
  const wasOn = autoRunSwitchOn(input.before);
  const isOn = autoRunSwitchOn(input.after);
  if (wasOn === isOn) return null;
  const lanes = autoRunMarketLanes(input.after, input.isLive);
  const { control } = await readAutoRunControl(repository, userId);
  const live = enabledMarketsByLane(lanes).live;
  return recordAutoRunChange(repository, {
    userId,
    action: isOn ? 'RUN' : 'STOP',
    reason: 'SETTINGS_SAVE',
    actor: 'member',
    lanes,
    control: isOn
      ? normalizeAutoRunControl({ ...control, liveConfirmedMarkets: [...control.liveConfirmedMarkets, ...live] })
      : control,
    now: input.now ?? new Date(),
  });
}

/** Record the member kill switch ("모든 자동매매 즉시 정지"). */
export async function recordAutoRunKillSwitch(repository: TradingRepository, userId: string, input: {
  policyBefore: TradingPolicy;
  isLive: AutoRunLiveResolver;
  now?: Date;
}) {
  const { control } = await readAutoRunControl(repository, userId);
  return recordAutoRunChange(repository, {
    userId,
    action: 'KILL_SWITCH',
    reason: 'MEMBER_KILL_SWITCH',
    actor: 'member',
    lanes: autoRunMarketLanes(input.policyBefore, input.isLive),
    control,
    now: input.now ?? new Date(),
  });
}

/**
 * Daily loss limit reached → auto-stop the member's run and record why.
 * New entries are blocked (newEntriesStopped) while protective exits of
 * owned automatic positions continue. Idempotent; never throws.
 */
export async function autoStopRunForLossLimit(repository: TradingRepository, userId: string, blockCodes: readonly string[]) {
  const reason = blockCodes.find((code) => AUTO_RUN_LOSS_STOP_CODES.has(code));
  if (!reason) return { stopped: false as const, reason: null };
  try {
    const current = await repository.getPolicy(userId);
    if (!autoRunSwitchOn(current)) return { stopped: false as const, reason };
    await repository.savePolicy(userId, { ...current, newEntriesStopped: true });
    const { control } = await readAutoRunControl(repository, userId);
    await recordAutoRunChange(repository, {
      userId, action: 'AUTO_STOP', reason, actor: 'system',
      lanes: registeredLiveResolver ? autoRunMarketLanes(current, registeredLiveResolver) : null,
      control, now: new Date(),
    });
    return { stopped: true as const, reason };
  } catch {
    return { stopped: false as const, reason };
  }
}
