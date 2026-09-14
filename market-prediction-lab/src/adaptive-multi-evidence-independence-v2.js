import { sha256Canonical } from "./research-cache-provenance.js";
import { verifyGlobalEvidenceLedger } from "./global-evidence-dedup-ledger-v1.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_POINT_IN_TIME_VERSION,
  ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
} from "./adaptive-multi-evidence-point-in-time-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_INDEPENDENCE_V2_VERSION =
  "adaptive-multi-evidence-independence-v2";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function canonicalUrl(value) {
  const normalized = text(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/iu.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function safety() {
  return {
    confidenceInflationAllowed: false,
    duplicateVoteCreditAllowed: false,
    economicSampleMutationAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function failure(blockers) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_INDEPENDENCE_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    groups: [],
    canonicalEvidence: [],
    exactDuplicateCount: 0,
    canonicalEvidenceCount: 0,
    independenceGroupCount: 0,
    independentVoteCredit: 0,
    economicSampleCredit: 0,
    blockers: unique(blockers),
    ...safety(),
  });
}

class DisjointSet {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  find(id) {
    const parent = this.parent.get(id);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot.localeCompare(rightRoot) <= 0 ? leftRoot : rightRoot);
    if (leftRoot !== rightRoot && this.parent.get(rightRoot) === rightRoot) this.parent.set(leftRoot, rightRoot);
  }
}

function connectionKeys(entry) {
  const identity = entry.evidence.evidence.identity;
  const relationship = entry.relationship ?? {};
  const sourceUrl = canonicalUrl(identity.sourceIdentity.sourceUrl);
  return unique([
    sourceUrl ? `url:${sourceUrl}` : null,
    identity.sourceIdentity.documentId ? `document:${identity.sourceIdentity.documentId}` : null,
    identity.sourceIdentity.originalSourceId ? `original:${identity.sourceIdentity.originalSourceId}` : null,
    text(relationship.canonicalEventId) ? `event:${text(relationship.canonicalEventId)}` : null,
    text(relationship.canonicalClaimId) ? `claim:${text(relationship.canonicalClaimId)}` : null,
    text(relationship.dataLineageId) ? `data:${text(relationship.dataLineageId)}` : null,
    text(relationship.upstreamSourceId) ? `upstream:${text(relationship.upstreamSourceId)}` : null,
  ]);
}

function validEntry(entry, decisionTime) {
  const evidence = entry?.evidence;
  return evidence?.schemaVersion === ADAPTIVE_MULTI_EVIDENCE_POINT_IN_TIME_VERSION
    && evidence.status === "ADMISSIBLE"
    && evidence.executionAuthority === "NONE"
    && evidence.evidence?.lineageId === ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
    && evidence.evidence?.executionAuthority === "NONE"
    && evidence.evidence?.identity?.temporal?.decisionTime === decisionTime;
}

export function buildAdaptiveMultiEvidenceIndependenceV2({
  decisionTime,
  entries,
  economicEvidenceLedger,
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  const normalizedDecisionTime = text(decisionTime);
  if (!normalizedDecisionTime || !Number.isFinite(Date.parse(normalizedDecisionTime))) {
    blockers.push("V2_INDEPENDENCE_DECISION_TIME_REQUIRED");
  }
  const at = blockers.length === 0 ? new Date(normalizedDecisionTime).toISOString() : null;
  if (!Array.isArray(entries)) blockers.push("V2_INDEPENDENCE_ENTRY_ARRAY_REQUIRED");
  if (executionAuthority !== "NONE") blockers.push("V2_INDEPENDENCE_EXECUTION_AUTHORITY_FORBIDDEN");
  if (economicEvidenceLedger != null && !verifyGlobalEvidenceLedger(economicEvidenceLedger).valid) {
    blockers.push("GLOBAL_ECONOMIC_EVIDENCE_LEDGER_OWNER_INVALID");
  }
  if (Array.isArray(entries) && at) {
    entries.forEach((entry, index) => {
      if (!validEntry(entry, at)) blockers.push(`V2_INDEPENDENCE_EVIDENCE_${index}_INVALID`);
    });
  }
  if (blockers.length > 0) return failure(blockers);

  const byId = new Map();
  let exactDuplicateCount = 0;
  for (const entry of entries) {
    const id = entry.evidence.evidenceId;
    const existing = byId.get(id);
    if (existing) {
      if (existing.evidence.evidence.identity.contentDigest
          !== entry.evidence.evidence.identity.contentDigest) {
        blockers.push("V2_INDEPENDENCE_EVIDENCE_ID_CONTENT_CONFLICT");
      } else {
        exactDuplicateCount += 1;
      }
      continue;
    }
    byId.set(id, entry);
  }
  if (blockers.length > 0) return failure(blockers);

  const canonicalEntries = [...byId.values()];
  const ids = canonicalEntries.map((entry) => entry.evidence.evidenceId);
  const sets = new DisjointSet(ids);
  const firstByKey = new Map();
  const keysById = new Map();
  for (const entry of canonicalEntries) {
    const id = entry.evidence.evidenceId;
    const keys = connectionKeys(entry);
    keysById.set(id, keys);
    for (const key of keys) {
      if (firstByKey.has(key)) sets.union(firstByKey.get(key), id);
      else firstByKey.set(key, id);
    }
  }

  const membersByRoot = new Map();
  for (const entry of canonicalEntries) {
    const id = entry.evidence.evidenceId;
    const root = sets.find(id);
    const members = membersByRoot.get(root) ?? [];
    members.push(entry);
    membersByRoot.set(root, members);
  }
  const groups = [...membersByRoot.values()].map((members) => {
    const evidenceIds = members.map((entry) => entry.evidence.evidenceId).sort();
    const keys = unique(evidenceIds.flatMap((id) => keysById.get(id)));
    const families = unique(members.map((entry) => entry.evidence.evidence.identity.family));
    return {
      groupId: `adaptive-v2-independence:${sha256Canonical({ evidenceIds, keys })}`,
      evidenceIds,
      connectionKeys: keys,
      families,
      status: members.length > 1 ? "DEPENDENT_OR_DUPLICATED_SOURCES" : "INDEPENDENCE_NOT_PROVEN",
      canonicalSourceContribution: 1,
      independentVoteCredit: 0,
      economicSampleCredit: 0,
    };
  }).sort((left, right) => left.groupId.localeCompare(right.groupId));

  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_INDEPENDENCE_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "GROUPED_FOR_RESEARCH_ONLY",
    decisionTime: at,
    canonicalEvidence: canonicalEntries.map((entry) => entry.evidence),
    groups,
    exactDuplicateCount,
    canonicalEvidenceCount: canonicalEntries.length,
    independenceGroupCount: groups.length,
    groupCountIsNotVoteCount: true,
    independenceStatus: "NOT_PROVEN_UNTIL_VALIDATION",
    economicLedgerOwnerStatus: economicEvidenceLedger == null ? "NOT_SUPPLIED"
      : "VALIDATED_SEPARATE_ECONOMIC_OUTCOME_LEDGER",
    independentVoteCredit: 0,
    economicSampleCredit: 0,
    blockers: [],
    ...safety(),
  });
}
