import { createSafeStrategyDslV1, assertFormulaCandidateV1 } from '../../../market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js';
import { resolveCanonicalStrategyIdentity } from '../../../market-prediction-lab/src/canonical-strategy-identity-v1.js';
import { buildResearchDatasetIdentity, sha256Canonical as hash } from '../../../market-prediction-lab/src/research-cache-provenance.js';
import { buildEvidenceBackedFormulaExecutionParametersV1, createEvidenceBackedFormulaSignalEvaluatorV1 } from '../../../market-prediction-lab/src/evidence-backed-formula-entry-evaluator-v1.js';
import { runOnePassCandidateBacktestV1 } from '../../../market-prediction-lab/src/research-tournament-engine-v1.js';
import { createAuthoritativePaperGenericRiskPolicyProducer } from './authoritative-paper-generic-risk-policy-producer.service';
import { buildAuthoritativePaperRiskSizingEvidence, type AuthoritativePaperRiskSizingInput, type AuthoritativePaperRiskSizingMarket } from './authoritative-paper-risk-sizing-source.service';
import type { ResearchBundleResolution, ResearchSubmissionStore } from './research-bundle.contract';
import { researchBundleModelIdentity } from './research-bundle-model-identity.service';

type Row = Record<string, unknown>;
const COST_KEYS = ['commission', 'tax', 'spread', 'slippage', 'funding', 'latency', 'liquidityImpact', 'partialFillImpact'] as const;
const SCOPE_KEYS = ['datasetId', 'datasetDigest', 'market', 'symbol', 'timeframe', 'researchCodeSha'] as const;
const row = (v: unknown): Row => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(row) : [];
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const nonnegative = (v: unknown): v is number => finite(v) && v >= 0;
const times = (v: unknown): number[] => Array.isArray(v) && v.length > 0 && v.every(x => Number.isSafeInteger(x) && x > 0) ? v : [];
const minimum = (v: number[]) => v.reduce((a, b) => Math.min(a, b), Infinity);
const maximum = (v: number[]) => v.reduce((a, b) => Math.max(a, b), -Infinity);
const fresh = (v: Row, now: number) => positive(v.observedAtMs) && positive(v.maximumAgeMs) && v.observedAtMs <= now && now - v.observedAtMs <= v.maximumAgeMs;
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && hash(a) === hash(b);
const scoped = (v: Row, scope: Row) => SCOPE_KEYS.every(key => v[key] === scope[key]);
function sealed(v: unknown): Row | null {
  const r = row(v);
  return text(r.id) && /^[a-f0-9]{64}$/.test(String(r.digest)) && Object.keys(row(r.payload)).length > 0 && r.digest === hash(r.payload) ? row(r.payload) : null;
}
function blank(): ResearchBundleResolution {
  return { schemaVersion: 'research-bundle-resolution-v1', dslValid: false, dslDigest: null, bundleDigest: null,
    strategyIdentityDigest: null, modelIdentityDigest: null, featureOrderDigest: null, preprocessingVersion: null,
    researchBundleReady: false, backtestExecutable: false,
    backtestSubmitted: false, backtestCompleted: false, backtestStatus: 'BLOCKED_DATA', backtesterCalls: 0,
    resultArtifactDigest: null, publicationStatus: 'MISSING_EVIDENCE',
    components: [], blockers: [], wfStatus: 'NOT_EVALUATED', oosStatus: 'NOT_EVALUATED', holdoutStatus: 'NOT_EVALUATED',
    wfEvidencePresent: false, oosEvidencePresent: false, holdoutEvidencePresent: false, statisticalFirewallPass: false,
    statisticalFirewallStatus: 'MISSING_EVIDENCE', promotionEligible: false, profitabilityProven: false,
    champion: null, evidenceCredit: 0, executionAuthority: 'NONE', receipt: null };
}
function block(result: ResearchBundleResolution, code: string): ResearchBundleResolution {
  return { ...result, backtestExecutable: false, backtestStatus: 'BLOCKED_DATA', blockers: [...new Set([...result.blockers, code])] };
}
interface Dependencies {
  /** Server-owned immutable catalog read. Never populate from HTTP/AI/cache.
   * The current dashboard publishes cycle summaries, not strategy bundles; absent source stays null. */
  readCanonicalBundle?: (dslDigest: string) => Promise<unknown>;
  now?: () => number;
  submissions?: ResearchSubmissionStore;
  runBacktest?: (input: Row) => unknown | Promise<unknown>;
  /** Test harness only. The HTTP router never enables this. */
  allowTestEvidence?: boolean;
}
interface Admission { result: ResearchBundleResolution; source: Row; backtestInput: Row | null; }
function submissionMaterial(source: Row, result: ResearchBundleResolution) {
  const strategyIdentity = resolveCanonicalStrategyIdentity(row(source.strategy)).identity!;
  const dataset = row(source.dataset), risk = row(source.riskPolicy);
  return { strategyIdentity, strategyIdentityDigest: result.strategyIdentityDigest!, dslDigest: result.dslDigest!,
    modelIdentityDigest: result.modelIdentityDigest!, featureOrderDigest: result.featureOrderDigest!, preprocessingVersion: result.preprocessingVersion!,
    bundleDigest: result.bundleDigest!, datasetIdentity: String(dataset.id), datasetDigest: String(row(dataset.identity).datasetDigest),
    splitReceiptDigest: String(row(source.splitReceipt).digest), riskPolicyId: String(risk.policyId),
    riskPolicyVersion: String(risk.policyVersion), costPolicyIdentity: String(row(source.costPolicy).id),
    researchCodeSha: String(strategyIdentity.researchCodeSha) };
}
function resultMatches(raw: Row, source: Row): boolean {
  const formula = row(source.formulaCandidate), generated = row(source.generatedCandidate);
  const training = times(row(row(row(source.splitReceipt).payload).assignments).TRAIN);
  const safety = row(raw.safety), period = row(raw.period);
  return raw.status === 'PASS' && raw.canonicalBacktestOwner === '#690' && raw.executionEquivalent === true &&
    raw.executionEngine === 'runIndependentSignalBacktest' && raw.formulaCandidateId === formula.candidateId &&
    raw.strategyHash === formula.formulaHash && raw.parameterIdentity === generated.parameterIdentity &&
    raw.datasetIdentity === row(source.dataset).id && training.length > 0 &&
    period.startTime === minimum(training) && period.endTime === maximum(training) && period.includeFinalHoldout === false &&
    safety.executionAuthority === 'NONE' && ['LIVE_TRADING', 'AUTO_TRADING', 'REAL_ORDER_ENABLED',
      'PRIVATE_TRADING_API_ALLOWED', 'finalHoldoutPreAccessAllowed', 'profitabilityClaimAllowed', 'championPromotionAllowed',
      'orderSubmitted', 'orderCancelled', 'orderModified', 'transferSubmitted', 'withdrawalSubmitted'].every(key => safety[key] === false);
}
export class ResearchBundleService {
  constructor(private readonly deps: Dependencies = {}) {}
  async resolve(dsl: unknown): Promise<ResearchBundleResolution> { return (await this.admit(dsl)).result; }

  async readback(request: unknown): Promise<ResearchBundleResolution> {
    const input = row(request);
    if (!['bundleDigest,dsl,strategyIdentityDigest', 'bundleDigest,dsl,resultArtifactDigest,strategyIdentityDigest'].includes(Object.keys(input).sort().join(',')) ||
      (input.resultArtifactDigest != null && !/^[a-f0-9]{64}$/.test(String(input.resultArtifactDigest)))) return block(blank(), 'INVALID_RESEARCH_READBACK');
    const { result, source } = await this.admit(input.dsl);
    if (!result.researchBundleReady) return result;
    const reject = (code: string) => ({ ...block(result, code), publicationStatus: 'BLOCKED_DATA' as const });
    if (input.bundleDigest !== result.bundleDigest || input.strategyIdentityDigest !== result.strategyIdentityDigest) return reject('CANONICAL_READBACK_MISMATCH');
    if (!this.deps.submissions?.read) return { ...result, blockers: ['DURABLE_RESULT_READER_UNAVAILABLE'] };
    const material = submissionMaterial(source, result), requestDigest = hash(material);
    try {
      const publication = await this.deps.submissions.read(requestDigest);
      if (!publication) return { ...result, blockers: ['BACKTEST_ARTIFACT_NOT_DURABLY_PUBLISHED'] };
      const saved = row(publication.receipt), receipt = row(saved.receipt), { submittedAt, ...savedMaterial } = receipt;
      if (!same(savedMaterial, { ...material, requestDigest }) || !positive(submittedAt) || submittedAt > (this.deps.now ?? Date.now)() ||
        saved.backtestStatus !== 'COMPLETED' || saved.backtestCompleted !== true || saved.backtestSubmitted !== true || saved.backtesterCalls !== 1 ||
        saved.executionAuthority !== 'NONE' || saved.profitabilityProven !== false || saved.promotionEligible !== false || saved.champion !== null || saved.evidenceCredit !== 0 ||
        saved.wfStatus !== result.wfStatus || saved.oosStatus !== result.oosStatus || saved.holdoutStatus !== result.holdoutStatus ||
        saved.wfEvidencePresent !== false || saved.oosEvidencePresent !== false || saved.holdoutEvidencePresent !== false ||
        saved.statisticalFirewallPass !== false || saved.statisticalFirewallStatus !== 'MISSING_EVIDENCE' ||
        typeof saved.resultArtifactDigest !== 'string' || !/^[a-f0-9]{64}$/.test(saved.resultArtifactDigest) ||
        saved.resultArtifactDigest !== hash(publication.artifact) || !resultMatches(row(publication.artifact), source)) return reject('DURABLE_RESULT_READBACK_MISMATCH');
      if (input.resultArtifactDigest != null && input.resultArtifactDigest !== saved.resultArtifactDigest) return reject('CANONICAL_ARTIFACT_DIGEST_MISMATCH');
      // Revalidate source after storage IO; stale or changed policies cannot be relabeled current.
      const current = await this.admit(input.dsl);
      if (!current.result.researchBundleReady || current.result.bundleDigest !== result.bundleDigest) return reject('CANONICAL_READBACK_MISMATCH');
      return { ...result, backtestSubmitted: true, backtestCompleted: true, backtestStatus: 'COMPLETED', backtesterCalls: 0,
        resultArtifactDigest: saved.resultArtifactDigest, publicationStatus: 'READBACK_VERIFIED',
        receipt: { ...material, requestDigest, submittedAt } };
    } catch { return reject('DURABLE_RESULT_READBACK_UNAVAILABLE'); }
  }

  private async admit(rawDsl: unknown): Promise<Admission> {
    const result = blank();
    let source: Row = {}, backtestInput: Row | null = null;
    const add = (key: string, blockers: string[], missing = false) => {
      const unique = [...new Set(blockers)];
      result.components.push({ key, status: unique.length ? missing ? 'MISSING_EVIDENCE' : 'BLOCKED_DATA' : 'READY', blockers: unique });
      result.blockers.push(...unique);
    };
    try {
      if (JSON.stringify(rawDsl).length > 32_000) throw new Error('DSL_TOO_LARGE');
      const dsl = createSafeStrategyDslV1(rawDsl);
      result.dslValid = true; result.dslDigest = dsl.dslHash;
      const now = (this.deps.now ?? Date.now)();
      if (!positive(now)) throw new Error('CLOCK_INVALID');
      try { source = row(structuredClone(await this.deps.readCanonicalBundle?.(dsl.dslHash) ?? null)); }
      catch { result.blockers.push('CANONICAL_BUNDLE_SOURCE_UNAVAILABLE'); }
      const strategy = row(source.strategy), dataset = row(source.dataset), identity = row(dataset.identity);
      const formula = row(source.formulaCandidate), generated = row(source.generatedCandidate);
      const canonicalIdentity = resolveCanonicalStrategyIdentity(strategy);
      const strategyErrors: string[] = [];
      if (canonicalIdentity.status !== 'IDENTITY_COMPLETE') strategyErrors.push('STRATEGY_IDENTITY_MISSING_OR_INVALID');
      if (source.schemaVersion !== 'research-bundle-source-v1') strategyErrors.push('CANONICAL_BUNDLE_SOURCE_MISSING');
      if ((source.evidenceClass !== 'CANONICAL' && !(source.evidenceClass === 'TEST_ONLY' && this.deps.allowTestEvidence === true)) ||
        (this.deps.allowTestEvidence !== true && /TEST_ONLY|FIXTURE|SYNTHETIC/i.test(String(identity.sourceType))))
        strategyErrors.push('NON_CANONICAL_EVIDENCE_CLASS');
      try {
        const canonicalDsl = createSafeStrategyDslV1(source.dsl);
        assertFormulaCandidateV1(formula);
        if (canonicalDsl.dslHash !== dsl.dslHash || formula.dslHash !== dsl.dslHash ||
          formula.formulaHash !== strategy.formulaHash || generated.parameterIdentity !== strategy.parameterHash ||
          formula.market !== strategy.market || formula.direction !== strategy.direction || formula.timeframe !== strategy.timeframe ||
          strategy.market !== dsl.market || strategy.timeframe !== dsl.timeframe || strategy.direction !== dsl.direction ||
          formula.strategyFamily !== strategy.strategyFamily) strategyErrors.push('STRATEGY_DSL_IDENTITY_MISMATCH');
        buildEvidenceBackedFormulaExecutionParametersV1({ formulaCandidate: formula, generatedCandidate: generated });
        createEvidenceBackedFormulaSignalEvaluatorV1({ formulaCandidate: formula, generatedCandidate: generated });
      } catch { strategyErrors.push('CANONICAL_FORMULA_BINDING_INVALID'); }
      result.strategyIdentityDigest = canonicalIdentity.strategyIdentityDigest;
      add('strategy', source.strategy ? strategyErrors : ['STRATEGY_IDENTITY_MISSING_OR_INVALID', 'CANONICAL_BUNDLE_SOURCE_MISSING'], !source.strategy);
      const model = researchBundleModelIdentity(source, now, this.deps.allowTestEvidence === true);
      result.modelIdentityDigest = model.modelIdentityDigest;
      result.featureOrderDigest = model.featureOrderDigest;
      result.preprocessingVersion = model.preprocessingVersion;
      add('model', model.modelBlockers, !source.modelReference);
      add('feature', model.featureBlockers, !source.modelReference);
      const scope: Row = { datasetId: dataset.id, datasetDigest: identity.datasetDigest, market: dsl.market,
        symbol: identity.symbol, timeframe: dsl.timeframe, researchCodeSha: strategy.researchCodeSha };
      const dataErrors: string[] = [], candles = rows(dataset.rows);
      if (!text(dataset.id) || !text(identity.datasetDigest)) dataErrors.push('DATASET_IDENTITY_MISSING');
      if (identity.market !== dsl.market || identity.symbol !== row(source.riskSizingInput).symbol ||
        dataset.purpose !== 'STRATEGY_OHLCV' || /PUBLIC_FORWARD|LIQUIDITY_CALIBRATION/i.test(String(identity.sourceType)))
        dataErrors.push('DATASET_SCOPE_MISMATCH');
      if (identity.timeframe !== dsl.timeframe) dataErrors.push('DATASET_TIMEFRAME_MISMATCH');
      if (dataset.immutable !== true) dataErrors.push('DATASET_NOT_IMMUTABLE');
      const receipt = sealed(dataset.receipt);
      if (!receipt || !scoped(receipt, scope) || receipt.datasetIdentityId !== identity.datasetIdentityId ||
        receipt.rowCount !== candles.length || dataset.id !== strategy.datasetId || identity.datasetDigest !== strategy.datasetDigest ||
        identity.researchCodeSha !== strategy.researchCodeSha) dataErrors.push('DATASET_RECEIPT_INVALID');
      try {
        const rebuilt = buildResearchDatasetIdentity({ ...identity, rows: dataset.rows });
        if (rebuilt.datasetIdentityId !== identity.datasetIdentityId || !text(identity.sourceDigest)) dataErrors.push('DATASET_RECEIPT_INVALID');
      } catch { dataErrors.push('DATASET_RECEIPT_INVALID'); }
      if (dataset.pointInTimeSafe !== true || dataset.leakageStatus !== 'CLEAR' || identity.dataQualityStatus !== 'VERIFIED' ||
        identity.missingIntervalCount !== 0 || identity.duplicateRowCount !== 0 ||
        !positive(dataset.observedAtMs) || dataset.observedAtMs > now) dataErrors.push('DATASET_RECEIPT_INVALID');
      const candleTimes = candles.map(c => c.timestamp), candleSet = new Set(candleTimes);
      if (!positive(dataset.observationIntervalMs) || dataset.observationIntervalMs !== Number(dsl.timeframe.slice(0, -1)) *
        ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[dsl.timeframe.slice(-1)] ?? NaN))
        dataErrors.push('DATASET_TIMEFRAME_MISMATCH');
      if (!candles.length || candles.length > 250_000 || candles.some((c, i) =>
        !positive(c.timestamp) || !Number.isSafeInteger(c.timestamp) || c.timestamp > now || (i > 0 && Number(c.timestamp) <= Number(candles[i - 1].timestamp)) ||
        !['open', 'high', 'low', 'close'].every(k => positive(c[k])) || !nonnegative(c.volume) ||
        Number(c.high) < Math.max(Number(c.open), Number(c.close), Number(c.low)) ||
        Number(c.low) > Math.min(Number(c.open), Number(c.close)))) dataErrors.push('DATASET_RECEIPT_INVALID');
      if (candles[0]?.timestamp !== identity.actualStart || candles.at(-1)?.timestamp !== identity.actualEnd ||
        Date.parse(String(strategy.datasetStart)) !== identity.actualStart || Date.parse(String(strategy.datasetEnd)) !== identity.actualEnd)
        dataErrors.push('DATASET_RECEIPT_INVALID');
      add('dataset', source.dataset ? dataErrors : ['DATASET_IDENTITY_MISSING'], !source.dataset);

      const splitPolicy = sealed(source.splitPolicy), split = sealed(source.splitReceipt), splitErrors: string[] = [];
      if (!source.splitPolicy) splitErrors.push('FROZEN_SPLIT_POLICY_MISSING');
      if (!source.splitReceipt) splitErrors.push('FROZEN_SPLIT_RECEIPT_MISSING');
      if (!splitPolicy || !split || !scoped(splitPolicy, scope) || !scoped(split, scope) ||
        split?.policyDigest !== row(source.splitPolicy).digest) splitErrors.push('FROZEN_SPLIT_RECEIPT_INVALID');
      const assignment = row(split?.assignments);
      const train = times(assignment.TRAIN), validation = times(assignment.VALIDATION), oos = times(assignment.OOS);
      const all = [...train, ...validation, ...oos];
      if (!train.length || !validation.length || !oos.length || !same(splitPolicy?.assignments, split?.assignments) ||
        !same(identity.splitContract, split?.assignments) || all.length !== candleTimes.length || all.some(t => !candleSet.has(t)) ||
        split?.untouchedOos !== true) splitErrors.push('FROZEN_SPLIT_RECEIPT_INVALID');
      if (new Set(all).size !== all.length || maximum(train) >= minimum(validation) || maximum(validation) >= minimum(oos))
        splitErrors.push('ASSIGNMENT_OVERLAP');
      if (!positive(splitPolicy?.frozenAtMs) || !positive(splitPolicy?.firstOutcomeObservedAtMs) ||
        !positive(split?.observedAtMs) || Number(splitPolicy?.frozenAtMs) >= Number(splitPolicy?.firstOutcomeObservedAtMs) ||
        Number(splitPolicy?.frozenAtMs) >= Number(split?.observedAtMs) || Number(split?.observedAtMs) > now ||
        Number(splitPolicy?.firstOutcomeObservedAtMs) > Number(split?.observedAtMs) ||
        Number(splitPolicy?.frozenAtMs) >= Number(dataset.observedAtMs)) splitErrors.push('SPLIT_RETROSPECTIVE');
      const splitMissing = !source.splitPolicy || !source.splitReceipt;
      add('split', splitMissing ? splitErrors.filter(code => code.endsWith('_MISSING')) : splitErrors, splitMissing);

      const riskErrors: string[] = [], risk = row(source.riskPolicy), sizingInput = row(source.riskSizingInput);
      if (!source.riskPolicy) riskErrors.push('RISK_POLICY_RECORD_MISSING');
      const producer = createAuthoritativePaperGenericRiskPolicyProducer({ now: () => now, readCanonicalRecord: async () => source.riskPolicy });
      const policy = await producer({ market: dsl.market as AuthoritativePaperRiskSizingMarket,
        symbol: String(identity.symbol ?? ''), strategyScope: String(strategy.strategyId ?? ''), researchCodeSha: String(strategy.researchCodeSha ?? '') });
      if (!fresh(risk, now)) riskErrors.push('RISK_POLICY_STALE');
      if (risk.researchCodeSha !== strategy.researchCodeSha) riskErrors.push('RISK_POLICY_RESEARCH_SHA_MISMATCH');
      if (policy.blockers.some(b => /SCOPE|SYMBOL|MARKET/.test(b))) riskErrors.push('RISK_POLICY_SCOPE_MISMATCH');
      if (policy.status !== 'PRESENT') riskErrors.push(...policy.blockers);
      if (risk.policyId !== formula.riskPolicyIdentity || risk.policyVersion !== strategy.riskPolicyVersion ||
        sizingInput.market !== dsl.market || sizingInput.symbol !== identity.symbol ||
        sizingInput.strategyScope !== strategy.strategyId || sizingInput.researchCodeSha !== strategy.researchCodeSha ||
        sizingInput.side !== dsl.direction) riskErrors.push('RISK_POLICY_SCOPE_MISMATCH');
      // #769 remains the sole validator/calculator. No substitute quantity or policy defaults.
      const sizing = buildAuthoritativePaperRiskSizingEvidence({ ...sizingInput, riskPolicy: policy.policyEvidence } as AuthoritativePaperRiskSizingInput, now);
      if (sizing.status !== 'PRESENT' || !sizing.valid || !sizing.eligible) riskErrors.push('RISK_SIZING_VALIDATION_BLOCKED', ...sizing.blockers);
      add('risk', source.riskPolicy ? riskErrors : ['RISK_POLICY_RECORD_MISSING'], !source.riskPolicy);

      const costErrors: string[] = [], cost = sealed(source.costPolicy), components = row(cost?.components);
      if (!cost || row(source.costPolicy).id !== formula.costPolicyIdentity || strategy.costPolicyVersion !== row(source.costPolicy).id)
        costErrors.push('FULL_COST_LINEAGE_MISMATCH');
      if (!cost || !scoped(cost, scope) || !text(cost.bucket)) costErrors.push('FULL_COST_SCOPE_MISMATCH');
      for (const key of COST_KEYS) {
        const component = row(components[key]);
        if (!Object.hasOwn(components, key)) costErrors.push('FULL_COST_COMPONENT_MISSING:' + key);
        if (!scoped(component, scope) || component.bucket !== cost?.bucket) costErrors.push('FULL_COST_SCOPE_MISMATCH');
        if (!text(component.source) || !Array.isArray(component.provenance) || !component.provenance.length ||
          !component.provenance.every(text) || !fresh(component, now)) costErrors.push('FULL_COST_LINEAGE_MISMATCH');
        const v = component.value;
        const valid = key === 'commission' ? nonnegative(row(v).entryFeeRate) && nonnegative(row(v).exitFeeRate)
          : key === 'latency' ? Number.isSafeInteger(row(v).bars) && nonnegative(row(v).bars) && nonnegative(row(v).driftRate)
          : key === 'funding' ? Array.isArray(v) && v.every(f => positive(row(f).timestamp) && finite(row(f).rate))
          : nonnegative(v);
        if (!valid) costErrors.push('FULL_COST_INCOMPLETE');
      }
      add('fullCost', source.costPolicy ? costErrors : ['FULL_COST_INCOMPLETE'], !source.costPolicy);

      const oosPolicy = sealed(source.oosPolicy), wf = sealed(source.wfPolicy), holdout = sealed(source.holdoutPolicy);
      const frozen = (p: Row | null) => p && positive(p.frozenAtMs) && p.frozenAtMs <= Number(splitPolicy?.frozenAtMs) && p.frozenAtMs < Number(splitPolicy?.firstOutcomeObservedAtMs);
      const oosErrors = !oosPolicy ? ['OOS_HORIZON_POLICY_MISSING'] : [];
      if (oosPolicy && (!scoped(oosPolicy, scope) || !frozen(oosPolicy) || oosPolicy.untouched !== true ||
        oosPolicy.splitReceiptDigest !== row(source.splitReceipt).digest || oosPolicy.startTime !== minimum(oos) ||
        oosPolicy.endTime !== maximum(oos))) oosErrors.push('CONTAMINATION_RISK');
      add('oos', oosErrors, !source.oosPolicy);
      const wfErrors = !wf ? ['WF_POLICY_MISSING'] : [], windows = rows(wf?.windows);
      if (wf && (!scoped(wf, scope) || !frozen(wf) || !windows.length || windows.some(w => {
        const t = times(w.train), v = times(w.validation);
        return !t.length || !v.length || t.some(n => !train.includes(n)) || v.some(n => !validation.includes(n)) || maximum(t) >= minimum(v);
      }))) wfErrors.push('CONTAMINATION_RISK');
      add('wf', wfErrors, !source.wfPolicy);
      const holdoutErrors = !holdout ? ['HOLDOUT_IDENTITY_MISSING'] : [], held = times(holdout?.assignments);
      if (holdout && (!text(holdout.datasetId) || holdout.datasetId === dataset.id || !text(holdout.firewallIdentity) ||
        !frozen(holdout) || holdout.locked !== true || !held.length || held.some(t => all.includes(t)) ||
        minimum(held) <= maximum(all) || holdout.startTime !== minimum(held) || holdout.endTime !== maximum(held) ||
        ['market', 'symbol', 'timeframe', 'researchCodeSha'].some(k => holdout[k] !== scope[k]) ||
        ['outcomes', 'metrics', 'results'].some(k => Object.hasOwn(holdout, k)))) holdoutErrors.push('CONTAMINATION_RISK');
      add('holdout', holdoutErrors, !source.holdoutPolicy);
      result.holdoutStatus = holdout && !holdoutErrors.length ? 'LOCKED' : 'NOT_EVALUATED';
      result.blockers = [...new Set(result.blockers)];
      result.researchBundleReady = result.blockers.length === 0;
      if (result.researchBundleReady) {
        result.bundleDigest = hash(source); // ALL readback bytes, including selected parameters and freshness.
        const bt = row(source.backtest), costs = (key: string) => row(components[key]).value, executionErrors: string[] = [];
        if (!positive(bt.initialCapital) || !positive(bt.maximumCapitalFraction) || bt.maximumCapitalFraction > 1 ||
          !positive(bt.quantityStep) || bt.initialCapital !== sizing.equity ||
          bt.quantityStep !== row(row(sizingInput.contractRulesEvidence).rules).quantityStep) executionErrors.push('BACKTEST_EXPLICIT_RISK_INPUT_MISSING');
        // #690 cannot execute nonzero liquidity/partial-fill costs. Never silently omit them.
        if (costs('liquidityImpact') !== 0 || costs('partialFillImpact') !== 0) executionErrors.push('BACKTEST_COST_ADAPTER_UNSUPPORTED');
        if (!this.deps.submissions) executionErrors.push('DURABLE_SUBMISSION_STORE_MISSING');
        result.blockers.push(...executionErrors);
        result.backtestExecutable = executionErrors.length === 0;
        result.backtestStatus = result.backtestExecutable ? 'NOT_SUBMITTED' : 'BLOCKED_DATA';
        if (result.backtestExecutable) backtestInput = {
          market: dsl.market, symbol: identity.symbol, timeframe: dsl.timeframe, side: dsl.direction.toLowerCase(),
          candles: candles.filter(c => train.includes(Number(c.timestamp))), initialCapital: bt.initialCapital,
          riskModel: { riskPerTrade: Number(risk.riskPercent) / 100, leverage: risk.requestedLeverage,
            maximumCapitalFraction: bt.maximumCapitalFraction, quantityStep: bt.quantityStep },
          costModel: { ...row(costs('commission')), taxRate: costs('tax'), spreadRate: costs('spread'), slippageRate: costs('slippage'),
            latencyBars: row(costs('latency')).bars, latencyDriftRate: row(costs('latency')).driftRate },
          fundingRates: costs('funding'),
        };
      }
      return { result, source, backtestInput };
    } catch {
      return { result: block({ ...result, researchBundleReady: false }, result.dslValid ? 'CANONICAL_BUNDLE_INVALID' : 'DSL_INVALID'), source: {}, backtestInput: null };
    }
  }

  async submit(userId: string, request: unknown): Promise<ResearchBundleResolution> {
    const input = row(request);
    if (!text(userId) || Object.keys(input).sort().join(',') !== 'bundleDigest,dsl,strategyIdentityDigest')
      return block(blank(), 'INVALID_RESEARCH_SUBMISSION');
    const { result, source, backtestInput } = await this.admit(input.dsl);
    if (!result.backtestExecutable || !backtestInput) return result;
    if (input.bundleDigest !== result.bundleDigest || input.strategyIdentityDigest !== result.strategyIdentityDigest)
      return block(result, 'CANONICAL_READBACK_MISMATCH');
    const material = submissionMaterial(source, result), { strategyIdentity } = material, dataset = row(source.dataset);
    const requestDigest = hash(material), store = this.deps.submissions!;
    const running: ResearchBundleResolution = { ...result, backtestSubmitted: true, backtestStatus: 'RUNNING',
      receipt: { ...material, requestDigest, submittedAt: (this.deps.now ?? Date.now)() } };
    let reservation: Awaited<ReturnType<ResearchSubmissionStore['reserve']>>;
    try { reservation = await store.reserve(requestDigest, structuredClone(running)); }
    catch { return block(result, 'SUBMISSION_PERSISTENCE_UNAVAILABLE'); }
    if (!reservation || typeof reservation.acquired !== 'boolean') return block(result, 'SUBMISSION_RECEIPT_MISMATCH');
    if (!reservation.acquired) {
      const prior = row(reservation.receipt), saved = row(prior.receipt), { submittedAt, ...savedMaterial } = saved;
      const safetyKeys = ['executionAuthority', 'promotionEligible', 'profitabilityProven', 'champion', 'evidenceCredit',
        'wfEvidencePresent', 'oosEvidencePresent', 'holdoutEvidencePresent', 'statisticalFirewallPass', 'statisticalFirewallStatus', 'wfStatus', 'oosStatus'] as const;
      if (!same(savedMaterial, { ...material, requestDigest }) || !positive(submittedAt) || submittedAt > (this.deps.now ?? Date.now)() ||
        !safetyKeys.every(k => prior[k] === result[k]) || prior.holdoutStatus !== result.holdoutStatus ||
        !['RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED_DATA'].includes(String(prior.backtestStatus)) ||
        ![0, 1].includes(Number(prior.backtesterCalls)) || prior.backtestSubmitted !== true ||
        prior.backtestCompleted !== (prior.backtestStatus === 'COMPLETED') ||
        (prior.backtestCompleted && (prior.backtesterCalls !== 1 || !/^[a-f0-9]{64}$/.test(String(prior.resultArtifactDigest)))))
        return block(result, 'SUBMISSION_RECEIPT_MISMATCH');
      // Rebuild the safe projection, never forward a persisted authority field wholesale.
      return { ...result, backtestSubmitted: true, backtestCompleted: prior.backtestCompleted as boolean,
        backtestStatus: prior.backtestStatus as ResearchBundleResolution['backtestStatus'],
        backtesterCalls: Number(prior.backtesterCalls), receipt: { ...material, requestDigest, submittedAt },
        resultArtifactDigest: prior.backtestCompleted ? String(prior.resultArtifactDigest) : null,
        blockers: prior.backtestStatus === 'FAILED' || prior.backtestStatus === 'BLOCKED_DATA' ? ['PRIOR_SUBMISSION_BLOCKED_OR_FAILED'] : [] };
    }
    let completed: ResearchBundleResolution, calls = 0, artifact: Row | undefined;
    try {
      const rechecked = await this.admit(input.dsl); // Recheck after reservation IO.
      if (!rechecked.result.backtestExecutable || rechecked.result.bundleDigest !== result.bundleDigest) {
        const blocked = block(running, 'CANONICAL_READBACK_MISMATCH');
        await store.complete(requestDigest, blocked); return blocked;
      }
      const formulaCandidate = row(source.formulaCandidate), generatedCandidate = row(source.generatedCandidate);
      const parameters = buildEvidenceBackedFormulaExecutionParametersV1({ formulaCandidate, generatedCandidate });
      const evaluator = createEvidenceBackedFormulaSignalEvaluatorV1({ formulaCandidate, generatedCandidate });
      const training = times(row(row(row(source.splitReceipt).payload).assignments).TRAIN);
      calls += 1;
      const raw = row(await (this.deps.runBacktest ?? runOnePassCandidateBacktestV1)({
        formulaCandidate, generatedCandidate, datasetIdentity: dataset.id, backtestInput, executionParameters: parameters,
        ...evaluator, period: { startTime: minimum(training), endTime: maximum(training), includeFinalHoldout: false },
        finalHoldout: false, liquidityImpactEvidence: row(row(row(source.costPolicy).payload).components).liquidityImpact,
        strategyIdentity, researchBundleIdentity: result.bundleDigest, dslDigest: result.dslDigest,
      }));
      const success = resultMatches(raw, source);
      if (success) artifact = structuredClone(raw);
      completed = { ...running, backtesterCalls: 1, backtestCompleted: success, backtestStatus: success ? 'COMPLETED' : 'FAILED',
        resultArtifactDigest: success ? hash(raw) : null,
        blockers: success ? [] : [raw.status === 'PASS' ? 'BACKTEST_RESULT_IDENTITY_MISMATCH' : 'CANONICAL_BACKTEST_FAILED'] };
      // Historical completion has no WF/OOS/holdout/firewall/promotion authority.
    } catch {
      completed = { ...running, backtesterCalls: calls, backtestStatus: 'FAILED', blockers: ['CANONICAL_BACKTEST_FAILED'] };
    }
    try { await store.complete(requestDigest, structuredClone(completed), artifact); }
    catch { return { ...completed, backtestStatus: 'FAILED', backtestCompleted: false, blockers: ['SUBMISSION_COMPLETION_UNCONFIRMED'] }; }
    return completed;
  }
}
