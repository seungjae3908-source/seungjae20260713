import { createHash } from 'node:crypto';

export const ADAPTIVE_POLICY_RECORD_CONTRACT_V1 = 'adaptive-tournament-policy-record/v1';

const SHA64 = /^[0-9a-f]{64}$/i;
const SAFE_EVIDENCE_ID = /^[A-Za-z0-9._:/#-]{3,240}$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function exactIso(value, name) {
  const text = String(value ?? '');
  const date = new Date(text);
  const normalized = text.includes('.') ? text : text.replace(/Z$/u, '.000Z');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(text)
    || !Number.isFinite(date.getTime())
    || date.toISOString() !== normalized) {
    throw new TypeError(`${name} must be canonical ISO-8601 UTC`);
  }
  return date.toISOString();
}

function approvalEvidenceId(value) {
  const text = String(value ?? '').trim();
  if (!SAFE_EVIDENCE_ID.test(text)) throw new TypeError('approvalEvidenceId is invalid');
  return text;
}

export function adaptivePolicyDigestV1(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('adaptive policy must be an object');
  }
  return digest(policy);
}

export function createAdaptivePolicyRecordV1({
  policy,
  approvedAt,
  approvalEvidenceId: evidenceId,
} = {}) {
  const normalizedApprovedAt = exactIso(approvedAt, 'approvedAt');
  const normalizedEvidenceId = approvalEvidenceId(evidenceId);
  const policyDigest = adaptivePolicyDigestV1(policy);
  const core = {
    schemaVersion: 1,
    contract: ADAPTIVE_POLICY_RECORD_CONTRACT_V1,
    approvalStatus: 'APPROVED',
    approvalEvidenceId: normalizedEvidenceId,
    approvedAt: normalizedApprovedAt,
    policy,
    policyDigest,
    executionAuthority: 'NONE',
  };
  return Object.freeze({ ...core, recordDigest: digest(core) });
}

export function validateAdaptivePolicyRecordV1(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('adaptive policy record is required');
  }
  if (record.schemaVersion !== 1 || record.contract !== ADAPTIVE_POLICY_RECORD_CONTRACT_V1) {
    throw new Error('ADAPTIVE_POLICY_RECORD_CONTRACT_INVALID');
  }
  if (record.approvalStatus !== 'APPROVED') throw new Error('ADAPTIVE_POLICY_NOT_APPROVED');
  approvalEvidenceId(record.approvalEvidenceId);
  exactIso(record.approvedAt, 'approvedAt');
  if (record.executionAuthority !== 'NONE') throw new Error('ADAPTIVE_POLICY_AUTHORITY_INVALID');
  const expectedPolicyDigest = adaptivePolicyDigestV1(record.policy);
  if (!SHA64.test(String(record.policyDigest ?? '')) || record.policyDigest !== expectedPolicyDigest) {
    throw new Error('ADAPTIVE_POLICY_DIGEST_MISMATCH');
  }
  const core = {
    schemaVersion: 1,
    contract: ADAPTIVE_POLICY_RECORD_CONTRACT_V1,
    approvalStatus: record.approvalStatus,
    approvalEvidenceId: record.approvalEvidenceId,
    approvedAt: record.approvedAt,
    policy: record.policy,
    policyDigest: record.policyDigest,
    executionAuthority: record.executionAuthority,
  };
  if (!SHA64.test(String(record.recordDigest ?? '')) || record.recordDigest !== digest(core)) {
    throw new Error('ADAPTIVE_POLICY_RECORD_DIGEST_MISMATCH');
  }
  return Object.freeze({
    policy: record.policy,
    policyDigest: record.policyDigest,
    approvalEvidenceId: record.approvalEvidenceId,
    approvedAt: record.approvedAt,
  });
}
