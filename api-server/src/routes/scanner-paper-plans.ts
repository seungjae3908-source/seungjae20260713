import { Router, type IRouter } from 'express';
import { requireAdmin, type AuthenticatedRequest } from '../middleware/auth';
import {
  ProductPaperSourceError,
  productPaperSourceRegistry,
  type ProductPaperSourceRegistry,
} from '../services/product-paper-source-registry.service';
import type { ScannerCanonicalPaperCandidate } from '../services/scanner-canonical-paper-identity.service';
import type { CanonicalPaperAdmissionEvidenceBundle } from '../services/scanner-paper-admission-evidence-bundle.service';
import {
  resolveCanonicalPaperAdmissionBridgeCandidate as canonicalAdmissionBridgeOwner,
} from '../../../market-prediction-lab/src/canonical-paper-admission-bridge-v1.js';
import {
  resolveCanonicalPaperSimulationAuthority as canonicalSimulationAuthorityOwner,
} from '../../../market-prediction-lab/src/canonical-paper-simulation-authority-v1.js';
import {
  runRecurringPaperCycle as recurringPaperCycleOwner,
} from '../../../market-prediction-lab/src/recurring-paper-loop-v1.js';

const MAX_REQUEST_BYTES = 16 * 1024;
const CLIENT_INPUT_ERROR_CODES = new Set([
  'APPROVAL_MODE_REQUIRED',
  'AUTOMATIC_MODE_FORBIDDEN',
  'PAPER_ACCOUNT_MODE_REQUIRED',
  'PAPER_ADAPTER_REQUIRED',
  'LIVE_MODE_FORBIDDEN',
]);
const CLIENT_AUTHORITY_KEYS = new Set([
  'admissionBundle',
  'paperAdmissionEvidenceBundle',
  'canonicalEvidence',
  'executionEvidence',
  'profitGate',
  'profitEvidence',
  'riskEvidence',
  'paperState',
  'state',
  'cycle',
  'ledgerAdapter',
  'learningAdapter',
  'stateStore',
  'simulationAuthority',
  'executionPolicy',
  'marketAdapterIdentity',
  'order',
  'leverage',
]);

type ScannerPaperProfitGate = Readonly<{
  decision: 'ELIGIBLE' | 'NO_TRADE';
  eligible: boolean;
  reasons: readonly string[];
  executionAuthority: 'NONE';
}>;

type ScannerPaperProfitEvidence = Readonly<{
  status: string;
  expectedNetEdge: number | null;
  expectedNetReturn: number | null;
  riskRewardRatio: number | null;
  sampleSize: number;
  costPolicyId: string | null;
  executionAuthority: 'NONE';
}>;

export type ScannerPaperServerOwnerContext = Readonly<{
  admissionBundle: CanonicalPaperAdmissionEvidenceBundle;
  profitGate: ScannerPaperProfitGate;
  profitEvidence: ScannerPaperProfitEvidence;
  state: unknown;
  cycle: unknown;
  ledgerAdapter: unknown;
  learningAdapter: unknown;
  stateStore: unknown;
  settlementCostProducer?: unknown;
  simulatedOnly: true;
  executionAuthority: 'NONE';
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  productionMutationAllowed: false;
  naturalSampleCredit: 0;
}>;

export type ScannerPaperServerOwnerSource = (input: Readonly<{
  authenticatedAccountId: string;
  source: unknown;
  paperCandidate: ScannerCanonicalPaperCandidate;
  originalSignalDirection: string;
  nowMs: number;
}>) => Promise<ScannerPaperServerOwnerContext | null>;

const unavailableScannerPaperOwnerSource: ScannerPaperServerOwnerSource = async () => null;

function safety() {
  return {
    accountMode: 'PAPER',
    executionAuthority: 'NONE',
    liveOrderEnabled: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    evidenceCredit: 0,
  } as const;
}

function clientAuthorityKey(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (CLIENT_AUTHORITY_KEYS.has(key)) return key;
  }
  return null;
}

function safeOwnerContext(value: ScannerPaperServerOwnerContext | null): value is ScannerPaperServerOwnerContext {
  return Boolean(value)
    && value?.simulatedOnly === true
    && value.executionAuthority === 'NONE'
    && value.liveOrderAllowed === false
    && value.privateTradingApiAllowed === false
    && value.productionMutationAllowed === false
    && value.naturalSampleCredit === 0
    && Boolean(value.admissionBundle)
    && Boolean(value.profitGate)
    && Boolean(value.profitEvidence)
    && Boolean(value.state)
    && Boolean(value.cycle)
    && Boolean(value.ledgerAdapter)
    && Boolean(value.learningAdapter)
    && Boolean(value.stateStore);
}

function exactScannerIdentity(
  source: ScannerCanonicalPaperCandidate,
  admitted: Readonly<Record<string, any>> | null | undefined,
): boolean {
  if (!admitted) return false;
  const left = source.signal.strategyIdentity;
  const right = admitted.signal?.strategyIdentity;
  return source.candidateId === admitted.candidateId
    && source.signal.signalId === admitted.signal?.signalId
    && source.signal.market === admitted.signal?.market
    && source.signal.symbol === admitted.signal?.symbol
    && source.signal.timeframe === admitted.signal?.timeframe
    && source.signal.direction === admitted.signal?.direction
    && left.candidateId === right?.candidateId
    && left.strategyFamily === right?.strategyFamily
    && left.strategyId === right?.strategyId
    && left.strategyVersion === right?.strategyVersion
    && left.parameterHash === right?.parameterHash
    && left.parameterDigest === right?.parameterDigest
    && left.researchCodeSha === right?.researchCodeSha
    && left.costPolicyVersion === right?.costPolicyVersion
    && left.accountMode === right?.accountMode;
}

function serverIssuedLeverage(candidate: Readonly<Record<string, any>>, simulation: Readonly<Record<string, any>>) {
  if (candidate.signal?.market !== 'CRYPTO_FUTURES') {
    return Object.freeze({ leverage: null, leverageProvenance: 'NOT_APPLICABLE_CASH_OR_SPOT' as const });
  }
  const raw = simulation.execution?.dataEvidence?.leverage;
  const leverage = Number(raw);
  if (!Number.isFinite(leverage) || leverage <= 0) return null;
  return Object.freeze({ leverage, leverageProvenance: 'CANONICAL_SIMULATION_DATA_EVIDENCE' as const });
}

function publicPlan(result: any, candidate: any) {
  const samples = Array.isArray(result?.state?.samples) ? result.state.samples : [];
  const positions = Array.isArray(result?.state?.positions) ? result.state.positions : [];
  const sample = samples.find((row: any) => row?.identity?.candidateId === candidate.candidateId
    && row?.identity?.signalId === candidate.signal.signalId);
  const position = positions.find((row: any) => row?.candidateId === candidate.candidateId
    && row?.signalId === candidate.signal.signalId);
  if (!sample || sample.status !== 'OPEN' || !position) {
    return {
      ready: false as const,
      blockers: Array.isArray(sample?.blockers) && sample.blockers.length > 0
        ? [...new Set(sample.blockers.map(String))]
        : result?.summary?.replayed === true
          ? ['PAPER_CYCLE_REPLAY_WITHOUT_OPEN_POSITION']
          : ['PAPER_CYCLE_DID_NOT_OPEN_POSITION'],
    };
  }
  return {
    ready: true as const,
    duplicate: result?.summary?.entries === 0,
    plan: Object.freeze({
      id: sample.paperSampleId,
      candidateId: candidate.candidateId,
      market: candidate.signal.market,
      symbol: candidate.signal.symbol,
      timeframe: candidate.signal.timeframe,
      side: candidate.signal.direction,
      leverage: candidate.leverage ?? null,
      leverageProvenance: candidate.leverageProvenance,
      quantity: sample.fill?.filledQuantity ?? position.quantity ?? null,
      entryPrice: sample.fill?.fillPrice ?? position.entryFillPrice ?? null,
      notional: sample.fill?.notional ?? null,
      costPolicyVersion: candidate.signal.strategyIdentity.costPolicyVersion,
      strategyId: candidate.signal.strategyIdentity.strategyId,
      parameterHash: candidate.signal.strategyIdentity.parameterHash,
      signalExpiresAt: new Date(candidate.signal.expiresAtMs).toISOString(),
      state: 'PAPER_OPEN',
      executionAuthority: 'NONE',
    }),
    position: Object.freeze({
      id: position.positionId,
      candidateId: position.candidateId,
      signalId: position.signalId,
      market: position.market,
      symbol: position.symbol,
      direction: position.direction,
      quantity: position.quantity,
      entryFillPrice: position.entryFillPrice,
      lifecycleState: position.lifecycleState,
      executionAuthority: 'NONE',
    }),
  };
}

export function createScannerPaperPlansRouter(dependencies: {
  registry?: ProductPaperSourceRegistry;
  sourceSha?: () => string;
  now?: () => number;
  ownerSource?: ScannerPaperServerOwnerSource;
  resolveAdmission?: typeof canonicalAdmissionBridgeOwner;
  resolveSimulation?: typeof canonicalSimulationAuthorityOwner;
  runCycle?: typeof recurringPaperCycleOwner;
} = {}): IRouter {
  const router: IRouter = Router();
  const registry = dependencies.registry ?? productPaperSourceRegistry;
  const sourceSha = dependencies.sourceSha ?? (() => String(process.env.DEPLOY_SHA ?? '').trim().toLowerCase());
  const now = dependencies.now ?? Date.now;
  const ownerSource = dependencies.ownerSource ?? unavailableScannerPaperOwnerSource;
  const resolveCanonicalPaperAdmissionBridgeCandidate = dependencies.resolveAdmission ?? canonicalAdmissionBridgeOwner;
  const resolveCanonicalPaperSimulationAuthority = dependencies.resolveSimulation ?? canonicalSimulationAuthorityOwner;
  const runRecurringPaperCycle = dependencies.runCycle ?? recurringPaperCycleOwner;

  router.post('/scanner/plans', requireAdmin, async (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const envelope = safety();
    let length: number;
    try { length = Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8'); }
    catch { length = MAX_REQUEST_BYTES + 1; }
    if (length > MAX_REQUEST_BYTES) return res.status(413).json({ ok: false, error: 'REQUEST_TOO_LARGE', ...envelope });

    const forbidden = clientAuthorityKey(req.body);
    if (forbidden) {
      return res.status(400).json({
        ok: false,
        error: 'CLIENT_PAPER_AUTHORITY_FORBIDDEN',
        rejectedField: forbidden,
        ...envelope,
      });
    }

    try {
      const resolved = registry.resolveScanner(req.member!.id, req.body, sourceSha());
      const nowMs = now();
      const ownerContext = await ownerSource({
        authenticatedAccountId: req.member!.id,
        source: resolved.source,
        paperCandidate: resolved.paperCandidate,
        originalSignalDirection: resolved.originalSignalDirection,
        nowMs,
      });
      if (!safeOwnerContext(ownerContext)) {
        return res.status(503).json({
          ok: false,
          error: 'SERVER_OWNED_SCANNER_PAPER_EVIDENCE_REQUIRED',
          stage: 'SERVER_SOURCE_IDENTITY_VALIDATED',
          serverVerified: true,
          executionConnected: false,
          paperCandidate: resolved.paperCandidate,
          originalSignalDirection: resolved.originalSignalDirection,
          ...envelope,
        });
      }

      const admission = resolveCanonicalPaperAdmissionBridgeCandidate({
        bundle: ownerContext.admissionBundle,
        nowMs,
      });
      if (admission?.status !== 'BRIDGE_READY' || !admission.candidate) {
        return res.status(409).json({
          ok: false,
          error: 'CANONICAL_PAPER_ADMISSION_BLOCKED',
          blockers: admission?.blockers ?? ['CANONICAL_PAPER_ADMISSION_BLOCKED'],
          serverVerified: true,
          executionConnected: false,
          ...envelope,
        });
      }
      if (!exactScannerIdentity(resolved.paperCandidate, admission.candidate)) {
        return res.status(409).json({
          ok: false,
          error: 'SCANNER_CANONICAL_IDENTITY_CONTINUITY_MISMATCH',
          serverVerified: true,
          executionConnected: false,
          ...envelope,
        });
      }

      const simulation = resolveCanonicalPaperSimulationAuthority({
        candidate: admission.candidate,
        nowMs,
      });
      if (simulation?.status !== 'READY' || !simulation.execution || !simulation.order || !simulation.quote) {
        return res.status(409).json({
          ok: false,
          error: 'CANONICAL_PAPER_SIMULATION_BLOCKED',
          blockers: simulation?.blockers ?? ['CANONICAL_PAPER_SIMULATION_BLOCKED'],
          serverVerified: true,
          executionConnected: false,
          ...envelope,
        });
      }

      const leverage = serverIssuedLeverage(admission.candidate, simulation);
      if (!leverage) {
        return res.status(409).json({
          ok: false,
          error: 'SERVER_LEVERAGE_PROVENANCE_REQUIRED',
          serverVerified: true,
          executionConnected: false,
          ...envelope,
        });
      }

      const candidate = Object.freeze({
        ...admission.candidate,
        ...leverage,
        profitGate: ownerContext.profitGate,
        profitEvidence: ownerContext.profitEvidence,
        execution: simulation.execution,
        order: simulation.order,
        quote: simulation.quote,
        sampleExecutionReady: true,
        sampleExecutionBlockers: Object.freeze([]),
        simulationAuthority: Object.freeze({
          schemaVersion: simulation.schemaVersion,
          marketAdapterIdentity: simulation.marketAdapterIdentity,
          executionPolicyVersion: simulation.executionPolicy?.version ?? null,
          orderPolicyVersion: simulation.orderPolicy?.version ?? null,
          sampleExecutionReady: true,
          leverage: leverage.leverage,
          leverageProvenance: leverage.leverageProvenance,
          executionAuthority: 'NONE',
          simulatedOnly: true,
          liveOrderAllowed: false,
          privateTradingApiAllowed: false,
          orderSubmitted: false,
          exchangeRequestSent: false,
        }),
        executionAuthority: 'NONE',
        simulatedOnly: true,
        liveOrderAllowed: false,
        privateTradingApiAllowed: false,
        orderSubmitted: false,
        exchangeRequestSent: false,
        productionMutationAllowed: false,
      });

      const cycleResult = await runRecurringPaperCycle({
        state: ownerContext.state as never,
        cycle: ownerContext.cycle as never,
        candidates: [candidate] as never,
        exits: [],
        positionObservations: [],
        ledgerAdapter: ownerContext.ledgerAdapter as never,
        learningAdapter: ownerContext.learningAdapter as never,
        stateStore: ownerContext.stateStore as never,
        settlementCostProducer: (ownerContext.settlementCostProducer ?? null) as never,
      });
      const plan = publicPlan(cycleResult, candidate);
      if (!plan.ready) {
        return res.status(409).json({
          ok: false,
          error: 'CANONICAL_PAPER_CYCLE_BLOCKED',
          blockers: plan.blockers,
          serverVerified: true,
          executionConnected: true,
          ...envelope,
        });
      }

      return res.status(200).json({
        ok: true,
        serverVerified: true,
        executionConnected: true,
        duplicate: plan.duplicate,
        plan: plan.plan,
        position: plan.position,
        originalSignalDirection: resolved.originalSignalDirection,
        naturalSampleCredit: 0,
        profitabilityClaimAllowed: false,
        ...envelope,
      });
    } catch (error) {
      const sourceError = error instanceof ProductPaperSourceError ? error : null;
      const clientInputError = error instanceof Error && CLIENT_INPUT_ERROR_CODES.has(error.message)
        ? error.message
        : null;
      const safeCode = sourceError?.code
        ?? clientInputError
        ?? (error instanceof Error && /^[A-Z0-9_:-]{3,160}$/u.test(error.message)
          ? error.message
          : 'SCANNER_CANONICAL_PAPER_PLAN_FAILED');
      return res.status(sourceError?.status ?? (clientInputError ? 400 : 500)).json({ ok: false, error: safeCode, ...envelope });
    }
  });
  return router;
}
