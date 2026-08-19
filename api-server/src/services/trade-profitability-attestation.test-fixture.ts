import type {
  TradeProfitabilityAttestation,
  TradeProfitabilityAttestationRunner,
} from './trade-profitability-attestation.service';

const TEST_RESEARCH_SHA = '1111111111111111111111111111111111111111';
const TEST_PARAMETER_HASH = '2222222222222222222222222222222222222222222222222222222222222222';

export const allowServerProfitabilityAttestationForTests: TradeProfitabilityAttestationRunner = (input) => {
  const calibratedAt = new Date().toISOString();
  const result: TradeProfitabilityAttestation = {
    required: input.accountMode === 'live',
    allowed: true,
    blockCodes: [],
    source: 'SERVER_STRATEGY_PROMOTION',
    strategyId: input.strategyId,
    promotionState: input.accountMode === 'live' ? 'PROMOTION_CANDIDATE' : null,
    researchCodeSha: input.accountMode === 'live' ? TEST_RESEARCH_SHA : null,
    parameterHash: input.accountMode === 'live' ? TEST_PARAMETER_HASH : null,
    costPolicyVersion: input.accountMode === 'live' ? 'BACKTEST_FEES_SLIPPAGE_FUNDING_V1' : null,
    clientEconomicsTrusted: false,
    serverEconomics: input.accountMode === 'live'
      ? {
        sampleSize: 100,
        winProbability: 0.6,
        averageWinR: 1.5,
        averageLossR: 1,
        estimatedCostsR: 0.05,
        profitFactor: 1.5,
        maxDrawdownPercent: 10,
        marketRegime: 'bull',
        calibratedAt,
      }
      : null,
    orderAuthorityGranted: false,
  };
  return result;
};
