import { randomUUID } from 'node:crypto';

import {
  MEMBER_INVESTMENT_SAFETY,
  type AccountSnapshot,
  type BrokerExchangeConnection,
  type CryptoSpotHolding,
  type ExecutionPreview,
  type FuturesPosition,
  type OrderIntent,
  type StockHolding,
} from './member-investment.contract';

export type ReadonlyProviderBundle = {
  snapshot: AccountSnapshot;
  balances: AccountSnapshot[];
  stockHoldings: StockHolding[];
  cryptoSpotHoldings: CryptoSpotHolding[];
  futuresPositions: FuturesPosition[];
  openOrders: unknown[];
  orderHistory: unknown[];
};

export interface AccountProviderAdapter {
  validateConnection(connection: BrokerExchangeConnection): Promise<{ valid: boolean; errorCode: string | null }>;
  getAccountSnapshot(connection: BrokerExchangeConnection): Promise<AccountSnapshot>;
  getBalances(connection: BrokerExchangeConnection): Promise<AccountSnapshot[]>;
  getHoldings(connection: BrokerExchangeConnection): Promise<Array<StockHolding | CryptoSpotHolding>>;
  getPositions(connection: BrokerExchangeConnection): Promise<FuturesPosition[]>;
  getOpenOrders(connection: BrokerExchangeConnection): Promise<unknown[]>;
  getOrderHistory(connection: BrokerExchangeConnection): Promise<unknown[]>;
}

export interface ExecutionProviderAdapter {
  previewOrder(intent: OrderIntent, provider: BrokerExchangeConnection['provider']): Promise<ExecutionPreview>;
  placeOrder(intent: OrderIntent): Promise<never>;
  cancelOrder(orderId: string): Promise<never>;
  amendOrder(orderId: string): Promise<never>;
  transfer(asset: string, quantity: number): Promise<never>;
  withdraw(asset: string, quantity: number): Promise<never>;
}

export class FakeAccountProviderAdapter implements AccountProviderAdapter {
  constructor(private readonly fixture: ReadonlyProviderBundle) {}

  async validateConnection(connection: BrokerExchangeConnection) {
    const valid = connection.connectionStatus === 'CONNECTED' && connection.readOnlyCapable;
    return { valid, errorCode: valid ? null : 'ACCOUNT_CONNECTION_UNHEALTHY' };
  }

  async getAccountSnapshot() { return structuredClone(this.fixture.snapshot); }
  async getBalances() { return structuredClone(this.fixture.balances); }
  async getHoldings() {
    return structuredClone([...this.fixture.stockHoldings, ...this.fixture.cryptoSpotHoldings]);
  }
  async getPositions() { return structuredClone(this.fixture.futuresPositions); }
  async getOpenOrders() { return structuredClone(this.fixture.openOrders); }
  async getOrderHistory() { return structuredClone(this.fixture.orderHistory); }
}

export class PreviewOnlyExecutionProviderAdapter implements ExecutionProviderAdapter {
  constructor(private readonly now = () => new Date()) {}

  async previewOrder(intent: OrderIntent, provider: BrokerExchangeConnection['provider']): Promise<ExecutionPreview> {
    return {
      id: randomUUID(),
      userId: intent.userId,
      orderIntentId: intent.id,
      provider,
      estimatedNotional: intent.requestedQuantity * intent.requestedPrice,
      referencePrice: intent.requestedPrice,
      requestedQuantity: intent.requestedQuantity,
      status: 'PREVIEW_ONLY',
      warnings: [
        '실제 주문이 전송되지 않은 실행 미리보기입니다.',
        'LIVE 승인·provider 활성화·별도 실행 권한이 모두 잠겨 있습니다.',
      ],
      createdAt: this.now().toISOString(),
      expiresAt: intent.expiresAt,
      safety: MEMBER_INVESTMENT_SAFETY,
    };
  }

  async placeOrder(_intent: OrderIntent): Promise<never> { throw new Error('REAL_ORDER_EXECUTION_DISABLED'); }
  async cancelOrder(_orderId: string): Promise<never> { throw new Error('REAL_ORDER_EXECUTION_DISABLED'); }
  async amendOrder(_orderId: string): Promise<never> { throw new Error('REAL_ORDER_EXECUTION_DISABLED'); }
  async transfer(_asset: string, _quantity: number): Promise<never> { throw new Error('REAL_ORDER_EXECUTION_DISABLED'); }
  async withdraw(_asset: string, _quantity: number): Promise<never> { throw new Error('REAL_ORDER_EXECUTION_DISABLED'); }
}

export const CRYPTO_PRIVATE_ACCOUNT_RUNTIME = 'NOT_ACTIVATED' as const;
