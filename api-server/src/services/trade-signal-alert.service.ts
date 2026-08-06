import { createHash } from 'node:crypto';
import type { ScannerSignalLifecycle } from './trade-signal-lifecycle.service';

export type ScannerLifecycleAlert = {
  id: string;
  ownerId: string;
  signalId: string;
  market: string;
  symbol: string;
  timeframe: string;
  cycle: number;
  state: 'READY_FOR_APPROVAL';
  title: string;
  createdAt: string;
  expiresAt: string;
  score: number;
  confidence: number;
  riskScore: number;
  dataCompleteness: number;
  chaseRisk: ScannerSignalLifecycle['chaseRisk'];
  orderSubmitted: false;
  exchangeRequestSent: false;
};

export function scannerReadyAlertKey(signal: Pick<ScannerSignalLifecycle, 'ownerId' | 'signalId' | 'market' | 'symbol' | 'timeframe' | 'cycle'>) {
  return `scanner-ready:${createHash('sha256')
    .update([signal.ownerId, signal.signalId, signal.market, signal.symbol, signal.timeframe, signal.cycle].join('|'))
    .digest('hex')
    .slice(0, 32)}`;
}

export function deriveScannerReadyAlert(
  previous: ScannerSignalLifecycle | null,
  current: ScannerSignalLifecycle,
  deliveredKeys: ReadonlySet<string>,
  now = Date.now(),
): ScannerLifecycleAlert | null {
  if (current.state !== 'READY_FOR_APPROVAL') return null;
  if (current.dataState !== 'complete') return null;
  if (Date.parse(current.expiresAt) <= now) return null;
  if (previous?.state === 'READY_FOR_APPROVAL' && previous.cycle === current.cycle) return null;
  const id = scannerReadyAlertKey(current);
  if (deliveredKeys.has(id)) return null;
  return {
    id,
    ownerId: current.ownerId,
    signalId: current.signalId,
    market: current.market,
    symbol: current.symbol,
    timeframe: current.timeframe,
    cycle: current.cycle,
    state: 'READY_FOR_APPROVAL',
    title: `${current.symbol} 승인 대기 조건 확인`,
    createdAt: new Date(now).toISOString(),
    expiresAt: current.expiresAt,
    score: current.score,
    confidence: current.confidence,
    riskScore: current.riskScore,
    dataCompleteness: current.dataCompleteness,
    chaseRisk: current.chaseRisk,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

export function collectScannerReadyAlerts(
  transitions: ReadonlyArray<{ previous: ScannerSignalLifecycle | null; current: ScannerSignalLifecycle }>,
  deliveredKeys: ReadonlySet<string> = new Set(),
  now = Date.now(),
) {
  const nextDelivered = new Set(deliveredKeys);
  const alerts: ScannerLifecycleAlert[] = [];
  for (const transition of transitions) {
    const alert = deriveScannerReadyAlert(transition.previous, transition.current, nextDelivered, now);
    if (!alert) continue;
    alerts.push(alert);
    nextDelivered.add(alert.id);
  }
  return { alerts, deliveredKeys: nextDelivered };
}
