import { researchDigest } from "./research-trial-registry.js";

export const FREE_AI_PROVIDER_HEALTH_STATES = Object.freeze([
  "READY",
  "UNAVAILABLE",
  "RATE_LIMITED",
  "MISCONFIGURED",
]);

const HEALTH_SET = new Set(FREE_AI_PROVIDER_HEALTH_STATES);
const REQUIRED_ROLES = Object.freeze(["PROPOSER", "CRITIC"]);
const PROVIDER_SLOTS = Object.freeze(["AI_PROVIDER_A", "AI_PROVIDER_B"]);
const SENSITIVE_KEY = /(api[_-]?key|access[_-]?token|authorization|password|private[_-]?key|secret)/i;
const SAFE_FAILURE = /^[A-Z0-9_.:-]{1,120}$/;

function requiredTimestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be a timestamp`);
  return new Date(value).toISOString();
}

function walkForSecrets(value, path = "providers") {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`AI_PROVIDER_SECRET_METADATA_FORBIDDEN:${path}.${key}`);
    if (item && typeof item === "object") walkForSecrets(item, `${path}.${key}`);
  }
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function roleSupport(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze([...new Set(value.filter((item) => text(item)).map((item) => item.trim().toUpperCase()))].sort());
}

function failureReason(value, fallback) {
  const normalized = text(value)?.toUpperCase() ?? fallback;
  return SAFE_FAILURE.test(normalized) ? normalized : fallback;
}

function missingProvider(slot, checkedAt) {
  const core = Object.freeze({
    slot,
    providerName: "NOT_CONFIGURED",
    modelName: "NOT_CONFIGURED",
    availability: "UNAVAILABLE",
    roleSupport: Object.freeze([]),
    billingTier: "FREE",
    lastCheck: checkedAt,
    failureReason: "PROVIDER_NOT_CONFIGURED",
    healthState: "UNAVAILABLE",
  });
  return Object.freeze({ ...core, readinessFingerprint: researchDigest(core) });
}

function normalizeProvider(slot, raw, checkedAt) {
  if (!raw) return missingProvider(slot, checkedAt);
  const providerName = text(raw.providerName);
  const modelName = text(raw.modelName);
  const roles = roleSupport(raw.roleSupport);
  const billingTier = text(raw.billingTier)?.toUpperCase() ?? "UNKNOWN";
  const availability = text(raw.availability)?.toUpperCase() ?? "UNAVAILABLE";
  let healthState = HEALTH_SET.has(availability) ? availability : availability === "AVAILABLE" ? "READY" : "UNAVAILABLE";
  let reason = raw.failureReason == null ? null : failureReason(raw.failureReason, "PROVIDER_FAILURE_UNCLASSIFIED");
  if (billingTier !== "FREE") {
    healthState = "MISCONFIGURED";
    reason = "NON_FREE_PROVIDER_FORBIDDEN";
  } else if (!providerName || !modelName) {
    healthState = "MISCONFIGURED";
    reason = "PROVIDER_IDENTITY_INCOMPLETE";
  } else if (!REQUIRED_ROLES.every((role) => roles.includes(role))) {
    healthState = "MISCONFIGURED";
    reason = "ROLE_SUPPORT_INCOMPLETE";
  } else if (!HEALTH_SET.has(availability) && availability !== "AVAILABLE") {
    reason = "PROVIDER_AVAILABILITY_UNRECOGNIZED";
  } else if (healthState !== "READY" && !reason) {
    reason = `PROVIDER_${healthState}`;
  }
  const core = Object.freeze({
    slot,
    providerName: providerName ?? "NOT_CONFIGURED",
    modelName: modelName ?? "NOT_CONFIGURED",
    availability,
    roleSupport: roles,
    billingTier,
    lastCheck: raw.lastCheck == null ? checkedAt : requiredTimestamp(raw.lastCheck, `${slot}.lastCheck`),
    failureReason: reason,
    healthState,
  });
  return Object.freeze({ ...core, readinessFingerprint: researchDigest(core) });
}

function dualHealth(providerA, providerB) {
  if (providerA.healthState === "MISCONFIGURED" || providerB.healthState === "MISCONFIGURED") return "MISCONFIGURED";
  if (providerA.healthState === "RATE_LIMITED" || providerB.healthState === "RATE_LIMITED") return "RATE_LIMITED";
  if (providerA.healthState === "UNAVAILABLE" || providerB.healthState === "UNAVAILABLE") return "UNAVAILABLE";
  if (providerA.healthState !== "READY" || providerB.healthState !== "READY") return "UNAVAILABLE";
  if (providerA.providerName === providerB.providerName) return "MISCONFIGURED";
  return "READY";
}

export function buildFreeAiProviderReadiness({ providers = [], checkedAt } = {}) {
  const timestamp = requiredTimestamp(checkedAt, "checkedAt");
  if (!Array.isArray(providers)) throw new TypeError("providers must be an array");
  walkForSecrets(providers);
  const slots = providers.map((provider) => text(provider?.slot)?.toUpperCase());
  if (slots.some((slot) => !PROVIDER_SLOTS.includes(slot))) throw new Error("AI_PROVIDER_SLOT_UNSUPPORTED");
  if (slots.length !== new Set(slots).size) throw new Error("DUPLICATE_AI_PROVIDER_SLOT");
  const bySlot = Object.fromEntries(providers.map((provider, index) => [slots[index], provider]));
  const providerA = normalizeProvider(PROVIDER_SLOTS[0], bySlot[PROVIDER_SLOTS[0]], timestamp);
  const providerB = normalizeProvider(PROVIDER_SLOTS[1], bySlot[PROVIDER_SLOTS[1]], timestamp);
  const AI_DUAL_REVIEW_READY = dualHealth(providerA, providerB);
  const core = Object.freeze({
    schemaVersion: 1,
    checkedAt: timestamp,
    AI_PROVIDER_A_READY: providerA.healthState,
    AI_PROVIDER_B_READY: providerB.healthState,
    AI_DUAL_REVIEW_READY,
    providerChecks: Object.freeze({ AI_PROVIDER_A: providerA, AI_PROVIDER_B: providerB }),
    FREE_PROVIDER_ONLY: true,
    PAID_FALLBACK: false,
    AI_RESEARCH_STATUS: AI_DUAL_REVIEW_READY === "READY" ? "READY" : "AI_RESEARCH_UNAVAILABLE",
    readOnly: true,
    providerCallAttempted: false,
    secretValuesExposed: false,
  });
  return Object.freeze({ ...core, readinessDigest: researchDigest(core) });
}
