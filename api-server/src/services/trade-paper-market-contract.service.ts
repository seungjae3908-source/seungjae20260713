export type MarketType = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type Side = 'BUY' | 'SELL' | 'SHORT' | 'LONG' | 'EXIT';

export interface ReadinessEvidence {
  market: MarketType;
  provider: string;
  side: Side;
  isReducing?: boolean;
  cost: {
    commission: number;
    tax?: number;
  };
  session: {
    id: string;
    tick: number;
  };
  precision: number;
  liquidity: number;
  taxPolicy?: {
    enabled: boolean;
  };
  timestamp: number;
}

export interface ReadinessResult {
  allowed: boolean;
  reason?: string;
}

export function validatePaperReadiness(evidence: ReadinessEvidence, now: number = Date.now()): ReadinessResult {
  // Stale evidence check
  if (now - evidence.timestamp > 5000) {
    return { allowed: false, reason: 'STALE_EVIDENCE' };
  }

  // Enforce providers
  const expectedProvider = {
    'KR_STOCK': 'Toss',
    'US_STOCK': 'Toss',
    'CRYPTO_SPOT': 'Upbit',
    'CRYPTO_FUTURES': 'Bitget',
  }[evidence.market];

  if (evidence.provider !== expectedProvider) {
    return { allowed: false, reason: `PROVIDER_MISMATCH: Expected ${expectedProvider} for ${evidence.market}` };
  }

  // Cash (KR_STOCK, US_STOCK, CRYPTO_SPOT) - allow BUY/reducing SELL/EXIT
  const isCashMarket = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT'].includes(evidence.market);
  if (isCashMarket) {
    if (evidence.side === 'SHORT' || evidence.side === 'LONG') {
      return { allowed: false, reason: `CASH_MARKET_REJECTS_NEW_${evidence.side}` };
    }
    if ((evidence.side === 'SELL' || evidence.side === 'EXIT') && !evidence.isReducing) {
      return { allowed: false, reason: 'CASH_MARKET_REJECTS_NON_REDUCING_SELL' };
    }
  }

  // KR/US must require explicit session/tick/cost/tax-policy evidence
  if (['KR_STOCK', 'US_STOCK'].includes(evidence.market)) {
    if (!evidence.session.id || !evidence.session.tick || !evidence.cost.commission || evidence.taxPolicy === undefined) {
      return { allowed: false, reason: 'MISSING_KR_US_POLICY_EVIDENCE' };
    }
  }

  // Futures specific check
  if (evidence.market === 'CRYPTO_FUTURES') {
    if (!evidence.liquidity || !evidence.precision) {
      return { allowed: false, reason: 'MISSING_FUTURES_INPUTS' };
    }
  }

  return { allowed: true };
}
