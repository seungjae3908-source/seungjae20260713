import type { TradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { TradeExchangeReconciliationService } from './trade-exchange-reconciliation.service';
import { TradeExecutionService } from './trade-execution.service';
import type { TradingOrder, TradingPlan } from './trade-automation.types';

function ambiguousResponseCode(value: string | null) {
  const code = String(value ?? '').trim();
  if (!code) return false;
  if (['EXCHANGE_TIMEOUT', 'EXCHANGE_NETWORK_ERROR', 'BITGET_INVALID_RESPONSE', 'KIWOOM_INVALID_RESPONSE']
    .includes(code)) return true;
  if (/^EXCHANGE_HTTP_5\d\d$/.test(code)) return true;
  return /fetch failed|network|socket|connection reset|econnreset|econnrefused/i.test(code);
}

export class TradeExecutionCoordinator {
  private execution: TradeExecutionService;
  private automation: TradeAutomationService;
  private reconciliation: TradeExchangeReconciliationService;

  constructor(repository: TradingRepository) {
    this.execution = new TradeExecutionService(repository);
    this.automation = new TradeAutomationService(repository);
    this.reconciliation = new TradeExchangeReconciliationService(repository);
  }

  async execute(userId: string, plan: TradingPlan, order: TradingOrder) {
    let result = await this.execution.execute(userId, plan, order);
    if (result.state === 'REJECTED' && ambiguousResponseCode(result.lastErrorCode)) {
      result = await this.automation.transition(
        result,
        'RECOVERY_REQUIRED',
        'AMBIGUOUS_EXCHANGE_SUBMISSION_RESPONSE',
        {
          errorCode: result.lastErrorCode ?? 'AMBIGUOUS_EXCHANGE_RESPONSE',
          orderResubmitted: false,
        },
      );
    }
    if (result.state !== 'RECOVERY_REQUIRED') return result;
    return (await this.reconciliation.reconcileOrder(userId, plan, result)).order;
  }

  async cancel(userId: string, plan: TradingPlan, order: TradingOrder) {
    return this.execution.cancel(userId, plan, order);
  }

  async reconcileOrder(userId: string, plan: TradingPlan, order: TradingOrder) {
    return this.reconciliation.reconcileOrder(userId, plan, order);
  }

  async reconcileRecoverableOrders(userId: string) {
    await this.automation.recoverOpenOrders(userId);
    return this.reconciliation.reconcileRecoverableOrders(userId);
  }
}
