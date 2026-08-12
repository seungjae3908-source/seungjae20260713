import {
  createSupabaseTradingWorkerRepository,
  listSupabaseReconciliationCandidates,
  type TradingRepository,
} from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { TradeExecutionService } from './trade-execution.service';
import type { TradingOrder, TradingPlan } from './trade-automation.types';

type ReconcileOrder = (
  userId: string, plan: TradingPlan, order: TradingOrder, repository: TradingRepository,
) => Promise<TradingOrder>;

type SweepDependencies = {
  listCandidates?: (limit: number) => Promise<TradingOrder[]>;
  repositoryFactory?: (userId: string) => TradingRepository;
  reconcileOrder?: ReconcileOrder;
  limit?: number;
};

function errorCode(error: unknown) {
  return error instanceof Error ? error.message.split(':')[0] : 'TRADE_RECONCILIATION_FAILED';
}

export async function runTradeReconciliationSweep(dependencies: SweepDependencies = {}) {
  const limit = Math.max(1, Math.min(100, Math.trunc(dependencies.limit ?? 50)));
  const candidates = await (dependencies.listCandidates ?? listSupabaseReconciliationCandidates)(limit);
  const repositoryFactory = dependencies.repositoryFactory ?? createSupabaseTradingWorkerRepository;
  const reconcileOrder: ReconcileOrder = dependencies.reconcileOrder
    ?? ((userId, plan, order, repository) => new TradeExecutionService(repository).reconcile(userId, plan, order));
  let reconciled = 0;
  let recoveryRequired = 0;
  let failed = 0;

  for (const order of candidates) {
    let repository: TradingRepository | null = null;
    try {
      repository = repositoryFactory(order.userId);
      const plan = await repository.getPlan(order.userId, order.planId);
      if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND_DURING_RECONCILIATION');
      await reconcileOrder(order.userId, plan, order, repository);
      reconciled += 1;
    } catch (error) {
      failed += 1;
      if (!repository || order.state === 'RECOVERY_REQUIRED') continue;
      try {
        await new TradeAutomationService(repository).transition(
          order,
          'RECOVERY_REQUIRED',
          'PERIODIC_RECONCILIATION_FAILED',
          { errorCode: errorCode(error), retryScheduled: true },
        );
        recoveryRequired += 1;
      } catch {
        // The next bounded sweep retries storage/state failures. No exchange
        // order is ever resubmitted by this worker.
      }
    }
  }

  return { scanned: candidates.length, reconciled, recoveryRequired, failed, ordersSubmitted: 0 };
}

export function startTradeReconciliationWorker() {
  if (process.env.TRADE_RECONCILIATION_ENABLED !== 'true') return null;
  const configured = Number(process.env.TRADE_RECONCILIATION_INTERVAL_MS ?? 30_000);
  const intervalMs = Number.isFinite(configured) ? Math.max(10_000, Math.min(300_000, configured)) : 30_000;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runTradeReconciliationSweep();
      console.log(`[trade-reconciliation] scanned=${result.scanned} reconciled=${result.reconciled} recovery=${result.recoveryRequired} failed=${result.failed}`);
    } catch (error) {
      console.error(`[trade-reconciliation] sweep failed: ${errorCode(error)}`);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref?.();
  return timer;
}
