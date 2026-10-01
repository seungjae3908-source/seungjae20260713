// @ts-ignore -- canonical Prediction Lab JS is contract-tested but has no TS declaration yet.
import { BitgetPublicClient as BitgetPublicClientRuntime } from '../../../market-prediction-lab/src/bitget-public-client.js';
// @ts-ignore -- canonical Prediction Lab JS is contract-tested but has no TS declaration yet.
import { createNaturalPaperAuthoritativeSettlementCostCollector as createCollectorRuntime } from '../../../market-prediction-lab/src/natural-paper-authoritative-settlement-cost-collector-v1.js';
// @ts-ignore -- canonical Prediction Lab JS is contract-tested but has no TS declaration yet.
import { createPumpProspectiveFullCostSettlementOwnerV1 as createSettlementOwnerRuntime } from '../../../market-prediction-lab/src/crypto-pump-reversal-full-cost-settlement-v1.js';
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

type BitgetPublicClientLike = Readonly<{
  get(path: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
}>;
type CollectorInput = Readonly<{
  runtimePackage: Readonly<{
    buildPaperSimulatedExecutionEvidence: typeof buildPaperSimulatedExecutionEvidence;
    collectAuthoritativePaperLatencyCostEvidence: typeof collectAuthoritativePaperLatencyCostEvidence;
    readBitgetPublicLatencyMidpointQuote: typeof readBitgetPublicLatencyMidpointQuote;
  }>;
  readSupplementalCostInput(): Promise<SupplementalExecutionCostEvidence>;
  bitgetClient: BitgetPublicClientLike;
  now: () => number;
}>;
type AuthoritativeCollector = (input: Readonly<Record<string, unknown>>) => Promise<Readonly<Record<string, any>>>;
type CollectorFactory = (input: CollectorInput) => AuthoritativeCollector;
type SettlementOwnerFactory = (input: Readonly<{
  collectAuthoritativeEvidence: AuthoritativeCollector;
  clock: () => number;
}>) => (context: PumpFullCostContext) => Promise<Readonly<Record<string, any>>>;

const BitgetPublicClient = BitgetPublicClientRuntime as unknown as new () => BitgetPublicClientLike;
const createNaturalPaperAuthoritativeSettlementCostCollector =
  createCollectorRuntime as unknown as CollectorFactory;
const createPumpProspectiveFullCostSettlementOwnerV1 =
  createSettlementOwnerRuntime as unknown as SettlementOwnerFactory;

type PumpFullCostContext = Readonly<{
  record: Readonly<Record<string, any>>;
  state?: unknown;
  observedAtMs: number;
}>;

export function createPumpReversalFullCostSourceWiring(input: Readonly<{
  supplementalCostEvidenceForRecord:
    (context: PumpFullCostContext) =>
      SupplementalExecutionCostEvidence | Promise<SupplementalExecutionCostEvidence>;
  bitgetClient?: BitgetPublicClientLike;
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
