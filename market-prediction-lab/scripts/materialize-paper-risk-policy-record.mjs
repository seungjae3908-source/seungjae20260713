#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export const PAPER_RISK_POLICY_APPROVAL_SCHEMA = 'paper-risk-policy-human-approval-v1';
export const PAPER_RISK_POLICY_RUNTIME_RECORD_SCHEMA = 'authoritative-paper-generic-risk-policy-record-v1';
export const PAPER_RISK_POLICY_RUNTIME_RECORD_MAXIMUM_AGE_MS = 30_000;

const SHA40 = /^[0-9a-f]{40}$/u;
const STRATEGY_SCOPE = /^CRYPTO_FUTURES_(?:SCALP|SWING|POSITION)_V1_(?:LONG|SHORT)$/u;
const SYMBOL = /^[A-Z0-9._:-]{1,40}$/u;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() || null : null;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function exactStringArray(value, predicate = nonEmpty) {
  return Array.isArray(value) && value.length > 0 && value.every(predicate)
    && new Set(value).size === value.length;
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_POLICY_VALUE');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const object = record(value);
  if (!object) throw new TypeError('UNSUPPORTED_POLICY_VALUE');
  return Object.fromEntries(
    Object.entries(object)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function sha256Canonical(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function validateApprovedPaperRiskPolicyDecision(value) {
  const decision = record(value);
  const blockers = [];
  if (!decision) return { decision: null, blockers: ['POLICY_DECISION_MISSING'] };
  if (decision.schemaVersion !== PAPER_RISK_POLICY_APPROVAL_SCHEMA) blockers.push('POLICY_DECISION_SCHEMA_INVALID');
  if (!nonEmpty(decision.recordId)) blockers.push('POLICY_DECISION_RECORD_ID_REQUIRED');
  if (!nonEmpty(decision.policyId) || !nonEmpty(decision.policyVersion)) blockers.push('POLICY_DECISION_IDENTITY_REQUIRED');
  if (!nonEmpty(decision.source)) blockers.push('POLICY_DECISION_SOURCE_REQUIRED');
  if (!Number.isSafeInteger(decision.approvalIssue) || decision.approvalIssue <= 0
    || !Number.isSafeInteger(decision.approvalCommentId) || decision.approvalCommentId <= 0
    || !nonEmpty(decision.approvedBy)) blockers.push('POLICY_DECISION_APPROVAL_PROVENANCE_REQUIRED');
  if (decision.immutable !== true
    || decision.changeRule !== 'NEW_POLICY_VERSION_ONLY_NO_RETROSPECTIVE_MUTATION') {
    blockers.push('POLICY_DECISION_IMMUTABILITY_REQUIRED');
  }
  if (!exactStringArray(decision.marketScopes)
    || decision.marketScopes.some((market) => market !== 'CRYPTO_FUTURES')) {
    blockers.push('POLICY_DECISION_MARKET_SCOPE_INVALID');
  }
  if (!exactStringArray(decision.directionScopes)
    || !decision.directionScopes.includes('LONG') || !decision.directionScopes.includes('SHORT')
    || decision.directionScopes.some((direction) => direction !== 'LONG' && direction !== 'SHORT')) {
    blockers.push('POLICY_DECISION_DIRECTION_SCOPE_INVALID');
  }
  if (!exactStringArray(decision.strategyScopes, (scope) => typeof scope === 'string' && STRATEGY_SCOPE.test(scope))) {
    blockers.push('POLICY_DECISION_STRATEGY_SCOPE_INVALID');
  }
  if (!exactStringArray(decision.symbolScopes, (symbol) => typeof symbol === 'string' && SYMBOL.test(symbol))) {
    blockers.push('POLICY_DECISION_SYMBOL_SCOPE_INVALID');
  }
  if (!positive(decision.riskPercent) || decision.riskPercent > 1) blockers.push('POLICY_DECISION_RISK_PERCENT_INVALID');
  if (!positive(decision.requestedLeverage)) blockers.push('POLICY_DECISION_REQUESTED_LEVERAGE_INVALID');
  if (!positive(decision.maximumLeverage)) blockers.push('POLICY_DECISION_MAXIMUM_LEVERAGE_INVALID');
  if (positive(decision.requestedLeverage) && positive(decision.maximumLeverage)
    && decision.requestedLeverage > decision.maximumLeverage) {
    blockers.push('POLICY_DECISION_LEVERAGE_ORDER_INVALID');
  }
  if (decision.marginMode !== 'isolated' && decision.marginMode !== 'cross') {
    blockers.push('POLICY_DECISION_MARGIN_MODE_INVALID');
  }

  const economic = record(decision.economicEvidencePolicy);
  if (!economic || economic.futureNaturalPaperOnly !== true
    || economic.replayCredit !== 0 || economic.backfillCredit !== 0
    || economic.syntheticCredit !== 0 || economic.fixtureCredit !== 0) {
    blockers.push('POLICY_DECISION_ECONOMIC_CREDIT_BOUNDARY_INVALID');
  }
  const safety = record(decision.safety);
  if (!safety || safety.liveTrading !== false || safety.autoTrading !== false
    || safety.realOrderEnabled !== false || safety.privateTradingApiAllowed !== false
    || safety.executionAuthority !== 'NONE'
    || safety.productionDeployAuthority !== false || safety.stagingDeployAuthority !== false) {
    blockers.push('POLICY_DECISION_SAFETY_BOUNDARY_INVALID');
  }

  return blockers.length > 0
    ? { decision: null, blockers: Object.freeze(blockers) }
    : { decision: Object.freeze(structuredClone(decision)), blockers: Object.freeze([]) };
}

export function materializeApprovedPaperRiskPolicyRecord({
  decision,
  researchCodeSha,
  nowMs = Date.now(),
}) {
  const validated = validateApprovedPaperRiskPolicyDecision(decision);
  if (!validated.decision) {
    throw new Error(`PAPER_RISK_POLICY_DECISION_BLOCKED:${validated.blockers.join(',')}`);
  }
  const normalizedSha = String(researchCodeSha ?? '').trim().toLowerCase();
  if (!SHA40.test(normalizedSha)) throw new Error('PAPER_RISK_POLICY_EXACT_RESEARCH_SHA_REQUIRED');
  if (!positive(nowMs)) throw new Error('PAPER_RISK_POLICY_CLOCK_INVALID');

  const approved = validated.decision;
  const decisionDigest = sha256Canonical(approved);
  return Object.freeze({
    schemaVersion: PAPER_RISK_POLICY_RUNTIME_RECORD_SCHEMA,
    recordId: approved.recordId.trim(),
    recordVersion: `${approved.policyVersion.trim()}-runtime-observation-v1`,
    policyId: approved.policyId.trim(),
    policyVersion: approved.policyVersion.trim(),
    source: approved.source.trim(),
    provenance: Object.freeze([
      `approvalIssue:${approved.approvalIssue}`,
      `approvalComment:${approved.approvalCommentId}`,
      `approvedBy:${approved.approvedBy.trim()}`,
      `decisionDigest:${decisionDigest}`,
      'financialValuesFromApprovedDecision:true',
      'runtimeOnlyFields:researchCodeSha,observedAtMs,maximumAgeMs',
    ]),
    observedAtMs: nowMs,
    maximumAgeMs: PAPER_RISK_POLICY_RUNTIME_RECORD_MAXIMUM_AGE_MS,
    researchCodeSha: normalizedSha,
    marketScopes: Object.freeze([...approved.marketScopes]),
    strategyScopes: Object.freeze([...approved.strategyScopes]),
    symbolScopes: Object.freeze([...approved.symbolScopes]),
    riskPercent: approved.riskPercent,
    requestedLeverage: approved.requestedLeverage,
    maximumLeverage: approved.maximumLeverage,
    marginMode: approved.marginMode,
  });
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('usage: materialize-paper-risk-policy-record --decision <absolute-json> --research-sha <40-char-sha> --output <absolute-json>\n');
    return;
  }
  const decisionPath = argument('--decision');
  const researchCodeSha = argument('--research-sha');
  const outputPath = argument('--output');
  if (!decisionPath || !researchCodeSha || !outputPath
    || !isAbsolute(decisionPath) || !isAbsolute(outputPath)) {
    throw new Error('PAPER_RISK_POLICY_ABSOLUTE_PATHS_REQUIRED');
  }
  const decision = JSON.parse(await readFile(resolve(decisionPath), 'utf8'));
  const runtimeRecord = materializeApprovedPaperRiskPolicyRecord({ decision, researchCodeSha });
  await atomicJson(resolve(outputPath), runtimeRecord);
  process.stdout.write(JSON.stringify({
    status: 'MATERIALIZED',
    policyId: runtimeRecord.policyId,
    policyVersion: runtimeRecord.policyVersion,
    researchCodeSha: runtimeRecord.researchCodeSha,
    riskPercent: runtimeRecord.riskPercent,
    requestedLeverage: runtimeRecord.requestedLeverage,
    maximumLeverage: runtimeRecord.maximumLeverage,
    marginMode: runtimeRecord.marginMode,
    economicCreditCreated: false,
    executionAuthority: 'NONE',
  }) + '\n');
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry && import.meta.url === new URL(`file://${entry}`).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
