import type { TradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { TradeExchangeReconciliationService } from './trade-exchange-reconciliation.service';
import { TradeExecutionService } from './trade-execution.service';
import type { TradingOrder, TradingPlan } from './trade-automation.types';

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
    const result = await this.execution.execute(userId, plan, order);
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
