import {
  canonicalJson,
  sha256,
} from './public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_V4_TECHNICAL_IDENTITY_PROPOSAL,
} from './public-forward-liquidity-capture-seam-v4.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_V4_FUTURE_ACTIVATION_BINDING_SCHEMA =
  'public-forward-liquidity-v4-future-activation-binding/v1';

export const PUBLIC_FORWARD_LIQUIDITY_V4_INACTIVE_INTEGRATION_GATE = Object.freeze({
  schemaVersion: 'public-forward-liquidity-v4-inactive-integration-gate/v1',
  status: 'INACTIVE_PENDING_SEPARATE_HUMAN_ACTIVATION_AUTHORITY',
  technicalIdentitySchemaVersion:
    PUBLIC_FORWARD_LIQUIDITY_V4_TECHNICAL_IDENTITY_PROPOSAL.schemaVersion,
  technicalIdentityDigest: sha256(
    canonicalJson(PUBLIC_FORWARD_LIQUIDITY_V4_TECHNICAL_IDENTITY_PROPOSAL),
  ),
  runtimeActivationEnabled: false,
  collectorInvocationAllowed: false,
  scheduledRuntimeMutationAllowed: false,
  prospectiveEconomicCreditAllowed: false,
  replayCredit: 0,
  backfillCredit: 0,
  syntheticCredit: 0,
  manualCredit: 0,
  privateTradingApiAllowed: false,
  liveTradingAllowed: false,
  autoTradingAllowed: false,
  realOrderAllowed: false,
  executionAuthority: 'NONE',
});

const SAFE_AUTHORITY_REF = /^[A-Za-z0-9._:/#-]{1,240}$/u;
const SHA40 = /^[0-9a-f]{40}$/u;

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

export function verifyV4FutureActivationBinding(
  binding = {},
  { expectedTargetMainSha = null } = {},
) {
  const blockers = [];
  const expectedKeys = [
    'schemaVersion',
    'technicalIdentitySchemaVersion',
    'technicalIdentityDigest',
    'activationDecision',
    'humanAuthorityRef',
    'targetMainSha',
    'approvedAtMs',
  ];
  if (!exactKeys(binding, expectedKeys)) {
    blockers.push('V4_FUTURE_ACTIVATION_BINDING_SHAPE_INVALID');
  }
  if (binding?.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_V4_FUTURE_ACTIVATION_BINDING_SCHEMA) {
    blockers.push('V4_FUTURE_ACTIVATION_BINDING_SCHEMA_INVALID');
  }
  if (binding?.technicalIdentitySchemaVersion
    !== PUBLIC_FORWARD_LIQUIDITY_V4_INACTIVE_INTEGRATION_GATE.technicalIdentitySchemaVersion) {
    blockers.push('V4_FUTURE_ACTIVATION_TECHNICAL_SCHEMA_MISMATCH');
  }
  if (binding?.technicalIdentityDigest
    !== PUBLIC_FORWARD_LIQUIDITY_V4_INACTIVE_INTEGRATION_GATE.technicalIdentityDigest) {
    blockers.push('V4_FUTURE_ACTIVATION_TECHNICAL_DIGEST_MISMATCH');
  }
  if (binding?.activationDecision !== 'APPROVED_FOR_SEPARATE_ACTIVATION_PR_ONLY') {
    blockers.push('V4_FUTURE_ACTIVATION_DECISION_INVALID');
  }
  if (!SAFE_AUTHORITY_REF.test(String(binding?.humanAuthorityRef ?? '').trim())) {
    blockers.push('V4_FUTURE_ACTIVATION_HUMAN_AUTHORITY_REF_INVALID');
  }

  const bindingTargetMainSha = String(binding?.targetMainSha ?? '').trim().toLowerCase();
  const normalizedExpectedTargetMainSha = String(expectedTargetMainSha ?? '').trim().toLowerCase();
  if (!SHA40.test(bindingTargetMainSha)) {
    blockers.push('V4_FUTURE_ACTIVATION_TARGET_MAIN_SHA_INVALID');
  }
  if (!SHA40.test(normalizedExpectedTargetMainSha)) {
    blockers.push('V4_FUTURE_ACTIVATION_EXPECTED_MAIN_SHA_INVALID');
  } else if (bindingTargetMainSha !== normalizedExpectedTargetMainSha) {
    blockers.push('V4_FUTURE_ACTIVATION_TARGET_MAIN_SHA_MISMATCH');
  }

  if (!Number.isSafeInteger(binding?.approvedAtMs) || binding.approvedAtMs <= 0) {
    blockers.push('V4_FUTURE_ACTIVATION_APPROVED_AT_INVALID');
  }

  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export async function evaluateV4InactiveIntegrationGate({
  activationBinding = null,
  collector = null,
  expectedTargetMainSha = null,
} = {}) {
  const verification = verifyV4FutureActivationBinding(
    activationBinding ?? {},
    { expectedTargetMainSha },
  );
  const readyForSeparateActivationPr = verification.valid;

  return Object.freeze({
    schemaVersion: 'public-forward-liquidity-v4-inactive-integration-decision/v1',
    status: readyForSeparateActivationPr
      ? 'READY_FOR_SEPARATE_ACTIVATION_PR'
      : 'BLOCKED_ACTIVATION',
    blockers: verification.blockers,
    technicalIdentityDigest:
      PUBLIC_FORWARD_LIQUIDITY_V4_INACTIVE_INTEGRATION_GATE.technicalIdentityDigest,
    readyForSeparateActivationPr,
    collectorProvided: typeof collector === 'function',
    collectorInvoked: false,
    runtimeActivationEnabled: false,
    scheduledRuntimeMutationAllowed: false,
    prospectiveEconomicCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    syntheticCredit: 0,
    manualCredit: 0,
    liveTradingAllowed: false,
    privateTradingApiAllowed: false,
    realOrderAllowed: false,
    executionAuthority: 'NONE',
  });
}
