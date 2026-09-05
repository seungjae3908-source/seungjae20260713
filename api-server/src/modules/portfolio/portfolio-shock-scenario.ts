export type PortfolioShockPosition = {
  ticker: string;
  normalizedKRW: number | null;
};

export type PortfolioShock = {
  ticker: string;
  changePercent: number;
};

export type PortfolioShockResult = {
  scenarioStatus: 'SIMULATED' | 'PARTIAL_SIMULATION';
  equityBefore: number | null;
  equityAfter: number | null;
  pnlImpact: number | null;
  drawdownImpactPercent: number | null;
  impacts: Array<PortfolioShock & { positionValueKRW: number | null; impactKRW: number | null }>;
};

const finite = (value: number | null): value is number => value != null && Number.isFinite(value);

export function simulatePortfolioShock(input: {
  equityKRW: number | null;
  positions: readonly PortfolioShockPosition[];
  shocks: readonly PortfolioShock[];
}): PortfolioShockResult {
  const positions = new Map(input.positions.map((row) => [row.ticker.trim().toUpperCase(), row]));
  let knownImpactKRW = 0;
  const impacts = input.shocks.map((shock) => {
    const position = positions.get(shock.ticker.trim().toUpperCase());
    const impactKRW = position && finite(position.normalizedKRW)
      ? position.normalizedKRW * shock.changePercent / 100
      : null;
    if (impactKRW != null) knownImpactKRW += impactKRW;
    return { ...shock, ticker: shock.ticker.trim().toUpperCase(), positionValueKRW: position?.normalizedKRW ?? null, impactKRW };
  });
  const equityBefore = input.equityKRW;
  const complete = finite(equityBefore) && impacts.every((row) => row.impactKRW != null);
  return {
    scenarioStatus: complete ? 'SIMULATED' : 'PARTIAL_SIMULATION',
    equityBefore,
    equityAfter: complete ? equityBefore + knownImpactKRW : null,
    pnlImpact: complete ? knownImpactKRW : null,
    drawdownImpactPercent: complete && equityBefore > 0 ? knownImpactKRW / equityBefore * 100 : null,
    impacts,
  };
}
