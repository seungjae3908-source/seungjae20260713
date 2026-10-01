import { BitgetPublicClient } from '../../../market-prediction-lab/src/bitget-public-client.js';
import {
  createNaturalPaperAuthoritativeSettlementCostCollector,
} from '../../../market-prediction-lab/src/natural-paper-authoritative-settlement-cost-collector-v1.js';
import {
  createPumpProspectiveFullCostSettlementOwnerV1,
} from '../../../market-prediction-lab/src/crypto-pump-reversal-full-cost-settlement-v1.js';
import {
  buildPaperSimulatedExecutionEvidence,
} from './paper-simulated-execution-evidence.service';
import {
  collectAuthoritativePaperLatencyCostEvidence,
  readBitgetPublicLatencyMidpointQuote,
} from './authoritative-paper-latency-cost-evidence.service';
import type { SupplementalExecutionCostEvidence } from './scanner-profit-cost-evidence-adapter.service';

export const PUMP_REVERSAL_FULL_COST_SOURCE_WIRING_VERSION =
  'pump-reversal-full-cost-source-wiring-v1' as const;

type PumpFullCostContext = Readonly<{
  record: Readonly<Record<string, any>>;
  state?: unknown;
  observedAtMs: number;
}>;

type CollectorFactory = typeof createNaturalPaperAuthoritativeSettlementCostCollector;
type SettlementOwnerFactory = typeof createPumpProspectiveFullCostSettlementOwnerV1;

export function createPumpReversalFullCostSourceWiring(input: Readonly<{
  supplementalCostEvidenceForRecord:
    (context: PumpFullCostContext) =>
      SupplementalExecutionCostEvidence | Promise<SupplementalExecutionCostEvidence>;
  bitgetClient?: InstanceType<typeof BitgetPublicClient>;
  now?: () => number;
  collectorFactory?: CollectorFactory;
  settlementOwnerFactory?: SettlementOwnerFactory;
}>): Readonly<{
  settleFullCost(context: PumpFullCostContext): Promise<Readonly<Record<string, any>>>;
  executionAuthority: 'NONE';
  liveTrading: false;
  privateTradingApiAllowed: false;
  financialMutationAllowed: false;
}> {
  if (typeof input?.supplementalCostEvidenceForRecord !== 'function') {
    throw new TypeError('Pump Full Cost supplemental-cost owner is required');
  }
  const bitgetClient = input.bitgetClient ?? new BitgetPublicClient();
  const now = input.now ?? Date.now;
  const collectorFactory = input.collectorFactory ?? createNaturalPaperAuthoritativeSettlementCostCollector;
  const settlementOwnerFactory = input.settlementOwnerFactory ?? createPumpProspectiveFullCostSettlementOwnerV1;
  if (!bitgetClient || typeof (bitgetClient as any).get !== 'function'
    || typeof now !== 'function'
    || typeof collectorFactory !== 'function'
    || typeof settlementOwnerFactory !== 'function') {
    throw new TypeError('Pump Full Cost source wiring dependencies are required');
  }

  async function settleFullCost(context: PumpFullCostContext) {
    const collector = collectorFactory({
      runtimePackage: {
        buildPaperSimulatedExecutionEvidence,
        collectAuthoritativePaperLatencyCostEvidence,
        readBitgetPublicLatencyMidpointQuote,
      },
      readSupplementalCostInput: async () => input.supplementalCostEvidenceForRecord(context),
      bitgetClient,
      now,
    });
    const owner = settlementOwnerFactory({
      collectAuthoritativeEvidence: collector,
      clock: now,
    });
    return owner(context) as Promise<Readonly<Record<string, any>>>;
  }

  return Object.freeze({
    settleFullCost,
    executionAuthority: 'NONE',
    liveTrading: false,
    privateTradingApiAllowed: false,
    financialMutationAllowed: false,
  });
}

export const PUMP_REVERSAL_FULL_COST_SOURCE_WIRING_SAFETY = Object.freeze({
  schemaVersion: PUMP_REVERSAL_FULL_COST_SOURCE_WIRING_VERSION,
  canonicalPredictionLabSettlementOwnerRequired: true,
  authoritativePublicSettlementCollectorRequired: true,
  supplementalCostOwnerRequired: true,
  publicBitgetOnly: true,
  missingCostConvertedToZero: false,
  executionAuthority: 'NONE',
  liveTrading: false,
  privateTradingApiAllowed: false,
  financialMutationAllowed: false,
});
