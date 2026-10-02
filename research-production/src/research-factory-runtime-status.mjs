import { createHash } from 'node:crypto';

import { buildResearchFactoryControlPlaneV1 } from './research-factory-controller.mjs';
import { buildResearchDataFactoryOverviewV1 } from './research-data-factory.mjs';
import { validateAdaptivePolicyRecordV1 } from './adaptive-policy-record.mjs';
import { assessAdaptiveProfileReadinessV1 } from '../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';

export const RESEARCH_FACTORY_RUNTIME_STATUS_CONTRACT_V1 = 'research-factory-runtime-status/v1';

const SHA40 = /^[0-9a-f]{40}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function exactSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(sha)) throw new TypeError('researchSha must be exact SHA');
  return sha;
}

function exactIso(value) {
  const text = String(value ?? '');
  const date = new Date(text);
  const normalized = text.includes('.') ? text : text.replace(/Z$/u, '.000Z');
  if (!ISO.test(text)
    || !Number.isFinite(date.getTime())
    || date.toISOString() !== normalized) {
    throw new TypeError('observedAt invalid');
  }
  return date.toISOString();
}

function invalidPolicyStatus({ researchSha, observedAt, error }) {
  const core = {
    schemaVersion: 1,
    contract: RESEARCH_FACTORY_RUNTIME_STATUS_CONTRACT_V1,
    generatedAt: observedAt,
    researchSha,
    status: 'BLOCKED_POLICY_INVALID',
    firstZero: 'HUMAN_APPROVED_ADAPTIVE_POLICY_INVALID',
    policy: {
      present: true,
      valid: false,
      policyDigest: null,
      approvalEvidenceId: null,
      approvedAt: null,
    },
    dataFactory: {
      readyMarketCount: null,
      blockedMarketCount: null,
    },
    canonicalAdaptive: {
      readyProfileCount: null,
      blockedProfileCount: null,
      runtimeStatus: null,
      nextFirstZero: 'HUMAN_APPROVED_ADAPTIVE_POLICY_INVALID',
    },
    controlPlaneDigest: null,
    diagnostic: String(error?.message ?? error).replace(/[\r\n]/g, '_').slice(0, 240),
    safety: {
      runtimeExecutionAttempted: false,
      runtimeActivationAllowed: false,
      scheduleMutationAllowed: false,
      deploymentAllowed: false,
      databaseMutationAllowed: false,
      secretMutationAllowed: false,
      liveTrading: false,
      autoTrading: false,
      privateTradingApi: false,
      realOrder: false,
      profitabilityClaim: false,
      executionAuthority: 'NONE',
    },
  };
  return Object.freeze({ ...core, statusDigest: digest(core) });
}

function developmentDiagnosticsBlockedStatus({
  researchSha,
  observedAt,
  policyMeta,
  dataFactory,
  readiness,
  status,
  firstZero,
  diagnostic,
}) {
  const core = {
    schemaVersion: 1,
    contract: RESEARCH_FACTORY_RUNTIME_STATUS_CONTRACT_V1,
    generatedAt: observedAt,
    researchSha,
    status,
    firstZero,
    policy: policyMeta,
    dataFactory: {
      readyMarketCount: dataFactory.readyMarketCount,
      blockedMarketCount: dataFactory.blockedMarketCount,
    },
    canonicalAdaptive: {
      readyProfileCount: readiness.readyProfileCount,
      blockedProfileCount: readiness.blockedProfileCount,
      runtimeStatus: status,
      nextFirstZero: firstZero,
    },
    controlPlaneDigest: null,
    diagnostic: String(diagnostic ?? firstZero).replace(/[\r\n]/g, '_').slice(0, 240),
    safety: {
      runtimeExecutionAttempted: false,
      runtimeActivationAllowed: false,
      scheduleMutationAllowed: false,
      deploymentAllowed: false,
      databaseMutationAllowed: false,
      secretMutationAllowed: false,
      liveTrading: false,
      autoTrading: false,
      privateTradingApi: false,
      realOrder: false,
      profitabilityClaim: false,
      executionAuthority: 'NONE',
    },
  };
  return Object.freeze({ ...core, statusDigest: digest(core) });
}

export function buildResearchFactoryRuntimeStatusV1({
  researchSha,
  observedAt,
  policyRecord = null,
  dataEvidenceByMarket = {},
  adaptiveEvidenceCatalog = {},
  developmentDiagnostics = {},
  runtimeBindings = {},
} = {}) {
  const sha = exactSha(researchSha);
  const at = exactIso(observedAt);

  let policy = null;
  let policyMeta = {
    present: false,
    valid: false,
    policyDigest: null,
    approvalEvidenceId: null,
    approvedAt: null,
  };
  if (policyRecord != null) {
    let validated;
    try {
      validated = validateAdaptivePolicyRecordV1(policyRecord);
    } catch (error) {
      return invalidPolicyStatus({ researchSha: sha, observedAt: at, error });
    }
    policy = validated.policy;
    policyMeta = {
      present: true,
      valid: true,
      policyDigest: validated.policyDigest,
      approvalEvidenceId: validated.approvalEvidenceId,
      approvedAt: validated.approvedAt,
    };
  }

  if (policy != null) {
    const readiness = assessAdaptiveProfileReadinessV1({
      evidenceCatalog: adaptiveEvidenceCatalog,
    });
    const readyProfileIds = readiness.profiles
      .filter((profile) => profile.status === 'READY')
      .map((profile) => profile.profileId);
    const diagnostics = developmentDiagnostics && typeof developmentDiagnostics === 'object'
      && !Array.isArray(developmentDiagnostics)
      ? developmentDiagnostics
      : {};
    const missingProfileIds = readyProfileIds.filter((profileId) =>
      !Object.prototype.hasOwnProperty.call(diagnostics, profileId)
    );
    if (missingProfileIds.length > 0) {
      return developmentDiagnosticsBlockedStatus({
        researchSha: sha,
        observedAt: at,
        policyMeta,
        dataFactory: buildResearchDataFactoryOverviewV1({
          evidenceByMarket: dataEvidenceByMarket,
        }),
        readiness,
        status: 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING',
        firstZero: 'DEVELOPMENT_DIAGNOSTIC_REQUIRED',
        diagnostic: `missingProfileCount=${missingProfileIds.length};profiles=${missingProfileIds.join(',')}`,
      });
    }
  }

  let control;
  try {
    control = buildResearchFactoryControlPlaneV1({
      researchSha: sha,
      observedAt: at,
      evidenceByMarket: dataEvidenceByMarket,
      adaptive: policy == null
        ? {}
        : {
            policy,
            evidenceCatalog: adaptiveEvidenceCatalog,
            developmentDiagnostics,
            bindings: runtimeBindings,
          },
    });
  } catch (error) {
    const code = String(error?.code ?? error?.message ?? '');
    if (/^(?:DEVELOPMENT_|HINDSIGHT_FEEDBACK_FORBIDDEN)/.test(code)) {
      const readiness = assessAdaptiveProfileReadinessV1({
        evidenceCatalog: adaptiveEvidenceCatalog,
      });
      return developmentDiagnosticsBlockedStatus({
        researchSha: sha,
        observedAt: at,
        policyMeta,
        dataFactory: buildResearchDataFactoryOverviewV1({
          evidenceByMarket: dataEvidenceByMarket,
        }),
        readiness,
        status: 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_INVALID',
        firstZero: 'DEVELOPMENT_DIAGNOSTIC_INVALID',
        diagnostic: code,
      });
    }
    throw error;
  }

  const core = {
    schemaVersion: 1,
    contract: RESEARCH_FACTORY_RUNTIME_STATUS_CONTRACT_V1,
    generatedAt: at,
    researchSha: sha,
    status: control.status,
    firstZero: control.nextAction?.reason ?? control.canonicalAdaptive?.nextFirstZero ?? 'UNKNOWN',
    policy: policyMeta,
    dataFactory: {
      readyMarketCount: control.dataFactory.readyMarketCount,
      blockedMarketCount: control.dataFactory.blockedMarketCount,
    },
    canonicalAdaptive: {
      readyProfileCount: control.canonicalAdaptive.readyProfileCount,
      blockedProfileCount: control.canonicalAdaptive.blockedProfileCount,
      runtimeStatus: control.canonicalAdaptive.runtimeStatus,
      nextFirstZero: control.canonicalAdaptive.nextFirstZero,
    },
    controlPlaneDigest: control.controlPlaneDigest,
    diagnostic: null,
    safety: {
      runtimeExecutionAttempted: false,
      runtimeActivationAllowed: false,
      scheduleMutationAllowed: false,
      deploymentAllowed: false,
      databaseMutationAllowed: false,
      secretMutationAllowed: false,
      liveTrading: false,
      autoTrading: false,
      privateTradingApi: false,
      realOrder: false,
      profitabilityClaim: false,
      executionAuthority: 'NONE',
    },
  };
  return Object.freeze({ ...core, statusDigest: digest(core) });
}
