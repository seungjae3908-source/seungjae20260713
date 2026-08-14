export type PortfolioAllocationProfile = 'STABLE' | 'BALANCED' | 'GROWTH';
export type PortfolioAllocationClass = 'CASH' | 'KR_STOCKS' | 'US_STOCKS' | 'CRYPTO';
export type PortfolioWeightState = 'UNDERWEIGHT' | 'BALANCED' | 'OVERWEIGHT' | 'UNAVAILABLE';

export type PortfolioAllocationRange = {
  minPercent: number;
  maxPercent: number;
};

export const PORTFOLIO_ALLOCATION_POLICIES: Record<
  PortfolioAllocationProfile,
  Record<PortfolioAllocationClass, PortfolioAllocationRange>
> = {
  STABLE: {
    CASH: { minPercent: 20, maxPercent: 40 },
    KR_STOCKS: { minPercent: 25, maxPercent: 45 },
    US_STOCKS: { minPercent: 25, maxPercent: 45 },
    CRYPTO: { minPercent: 0, maxPercent: 10 },
  },
  BALANCED: {
    CASH: { minPercent: 10, maxPercent: 25 },
    KR_STOCKS: { minPercent: 25, maxPercent: 40 },
    US_STOCKS: { minPercent: 30, maxPercent: 50 },
    CRYPTO: { minPercent: 5, maxPercent: 20 },
  },
  GROWTH: {
    CASH: { minPercent: 5, maxPercent: 15 },
    KR_STOCKS: { minPercent: 20, maxPercent: 35 },
    US_STOCKS: { minPercent: 35, maxPercent: 55 },
    CRYPTO: { minPercent: 10, maxPercent: 30 },
  },
};

export function comparePortfolioAllocation(
  profile: PortfolioAllocationProfile,
  weights: Partial<Record<PortfolioAllocationClass, number | null>>,
) {
  const policy = PORTFOLIO_ALLOCATION_POLICIES[profile];
  const comparison = (Object.keys(policy) as PortfolioAllocationClass[]).map((assetClass) => {
    const value = weights[assetClass];
    const range = policy[assetClass];
    const state: PortfolioWeightState = value == null || !Number.isFinite(value)
      ? 'UNAVAILABLE'
      : value < range.minPercent
        ? 'UNDERWEIGHT'
        : value > range.maxPercent
          ? 'OVERWEIGHT'
          : 'BALANCED';
    return { assetClass, currentPercent: value ?? null, ...range, state };
  });
  return {
    profile,
    policy,
    status: comparison.some((item) => item.state === 'UNAVAILABLE') ? 'PARTIAL' as const : 'READY' as const,
    comparison,
  };
}
