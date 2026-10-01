import type { SupplementalExecutionCostEvidence } from './scanner-profit-cost-evidence-adapter.service';
import {
  createPumpReversalPublicRiskSourceWiring,
} from './pump-reversal-prospective-risk-source-wiring.service';
import {
  createPumpReversalFullCostSourceWiring,
} from './pump-reversal-prospective-full-cost-source-wiring.service';

export const PUMP_REVERSAL_RUNTIME_DEPENDENCIES_VERSION =
  'pump-reversal-prospective-runtime-dependencies-v1' as const;

type RiskWiringInput = Parameters<typeof createPumpReversalPublicRiskSourceWiring>[0];
type FullCostWiringInput = Parameters<typeof createPumpReversalFullCostSourceWiring>[0];
type RiskWiringFactory = typeof createPumpReversalPublicRiskSourceWiring;
type FullCostWiringFactory = typeof createPumpReversalFullCostSourceWiring;

type GenericContext = Readonly<Record<string, any>>;
type SupplementalSource = (
  context: GenericContext,
) => SupplementalExecutionCostEvidence | Promise<SupplementalExecutionCostEvidence>;

export function createPumpReversalProspectiveRuntimeDependencies(input: Readonly<{
  researchCodeSha: string;
  paperStateSnapshotForRecord: RiskWiringInput['paperStateSnapshotForRecord'];
  supplementalCostEvidenceForRecord: SupplementalSource;
  publicEvidenceForRecord?: RiskWiringInput['publicEvidenceForRecord'];
  fetchPublicJson?: RiskWiringInput['fetchPublicJson'];
  bitgetClient?: FullCostWiringInput['bitgetClient'];
  now?: () => number;
  riskWiringFactory?: RiskWiringFactory;
  fullCostWiringFactory?: FullCostWiringFactory;
}>): Readonly<{
  sizePaperRisk: ReturnType<ReturnType<RiskWiringFactory>['createOwner']>;
  settleFullCost: ReturnType<FullCostWiringFactory>['settleFullCost'];
  executionAuthority: 'NONE';
  liveTrading: false;
  privateTradingApiAllowed: false;
  financialMutationAllowed: false;
  scheduleActivationAuthority: false;
}> {
  if (typeof input?.paperStateSnapshotForRecord !== 'function'
    || typeof input?.supplementalCostEvidenceForRecord !== 'function') {
    throw new TypeError('Pump runtime Paper state and supplemental-cost owners are required');
  }
  const now = input.now ?? Date.now;
  const riskWiringFactory = input.riskWiringFactory ?? createPumpReversalPublicRiskSourceWiring;
  const fullCostWiringFactory = input.fullCostWiringFactory ?? createPumpReversalFullCostSourceWiring;
  if (typeof now !== 'function'
    || typeof riskWiringFactory !== 'function'
    || typeof fullCostWiringFactory !== 'function') {
    throw new TypeError('Pump runtime dependency factories are required');
  }

  const riskWiring = riskWiringFactory({
    researchCodeSha: input.researchCodeSha,
    paperStateSnapshotForRecord: input.paperStateSnapshotForRecord,
    supplementalCostEvidenceForRecord: (context) => input.supplementalCostEvidenceForRecord(context),
    ...(input.publicEvidenceForRecord == null ? {} : { publicEvidenceForRecord: input.publicEvidenceForRecord }),
    ...(input.fetchPublicJson == null ? {} : { fetchPublicJson: input.fetchPublicJson }),
    now,
  });
  const sizePaperRisk = riskWiring.createOwner();

  const fullCostWiring = fullCostWiringFactory({
    supplementalCostEvidenceForRecord: (context) => input.supplementalCostEvidenceForRecord(context),
    ...(input.bitgetClient == null ? {} : { bitgetClient: input.bitgetClient }),
    now,
  });

  return Object.freeze({
    sizePaperRisk,
    settleFullCost: fullCostWiring.settleFullCost,
    executionAuthority: 'NONE',
    liveTrading: false,
    privateTradingApiAllowed: false,
    financialMutationAllowed: false,
    scheduleActivationAuthority: false,
  });
}

export const PUMP_REVERSAL_RUNTIME_DEPENDENCIES_SAFETY = Object.freeze({
  schemaVersion: PUMP_REVERSAL_RUNTIME_DEPENDENCIES_VERSION,
  riskOwnerConnected: true,
  canonicalFullCostOwnerConnected: true,
  sharedSupplementalCostOwnerRequired: true,
  paperStateOwnerRequired: true,
  scheduleActivationAuthority: false,
  deploymentAuthority: false,
  financialMutationAllowed: false,
  executionAuthority: 'NONE',
  liveTrading: false,
  privateTradingApiAllowed: false,
});
