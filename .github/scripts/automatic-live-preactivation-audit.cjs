'use strict';

const REQUIRED_CHECKS = Object.freeze([
  'EXACT_DEPLOY_SHA', 'MEMBER_CAPABILITY', 'GLOBAL_AND_MEMBER_STOP',
  'FOUR_MARKET_POLICY', 'OWNER_APPROVED_POLICY_ALIGNMENT', 'FOUR_PROVIDER_CREDENTIALS',
  'SIGNAL_FRESHNESS_AND_SHA', 'GENUINE_SCANNER_AND_AI_CONNECTION',
  'STRATEGY_ALLOWLIST_SERVER_LINKAGE', 'CURRENT_AI_EVIDENCE',
  'CANONICAL_OWNERSHIP_AND_DUPLICATES', 'LIVE_PENDING_AND_RECOVERY',
  'ACCOUNT_TOSS', 'ACCOUNT_KIWOOM', 'ACCOUNT_UPBIT', 'ACCOUNT_BITGET',
  'ATOMIC_BUDGET_GUARD_INSTALLED',
].sort());
const ADDITIONAL_CONTROLS = Object.freeze([
  'MAIN_PRODUCTION_IDENTITY', 'REQUIRED_CI_AND_STAGING', 'FRESH_QA_ARTIFACTS',
  'EXACT_MANUAL_RECEIPTS', 'NO_GATE_CONFLICT', 'FRESH_MARKET_SESSION',
  'ATOMIC_AGGREGATE_BUDGET', 'NATIVE_FUTURES_PROTECTION', 'RECOVERY_WORKER_HEALTH',
  'PM2_PERSISTENCE_AND_ROLLBACK', 'POST_ARM_HEALTH',
].sort());

/** This is a required subset receipt, never a standalone activation permission. */
function assertMemberAccountSignalAudit(audit, { targetSha, generatedAt }) {
  const at = Date.parse(audit?.generatedAt);
  const receiptAt = Date.parse(generatedAt);
  const checks = audit?.checks;
  if (audit?.schemaVersion !== 'automatic-live-preactivation-audit-v1'
    || !/^[a-f0-9]{40}$/u.test(targetSha ?? '') || audit.targetSha !== targetSha
    || audit.scope !== 'MEMBER_ACCOUNT_AND_SIGNAL_READONLY_REHEARSAL'
    || audit.activationReady !== false || audit.ready !== true
    || !Number.isFinite(at) || !Number.isFinite(receiptAt) || at > receiptAt
    || receiptAt - at > 30 * 60_000
    || !Array.isArray(checks)
    || JSON.stringify(checks.map((c) => c?.id).sort()) !== JSON.stringify(REQUIRED_CHECKS)
    || checks.some((c) => c.status !== 'PASS' || !Array.isArray(c.codes) || c.codes.length !== 0)
    || !Array.isArray(audit.additionalRequiredControls)
    || JSON.stringify([...audit.additionalRequiredControls].sort()) !== JSON.stringify(ADDITIONAL_CONTROLS)
    || audit.paperOutOfScope !== true || audit.telegramOutOfScope !== true
    || ['orderRequests', 'cancelRequests', 'amendRequests', 'transferRequests', 'withdrawalRequests']
      .some((key) => audit[key] !== 0)
    || audit.liveTradingAuthorityGrantedByAudit !== false
    || audit.autoTradingAuthorityGrantedByAudit !== false) {
    throw new Error('POSTDEPLOY_QA_AUTO_LIVE_MEMBER_SIGNAL_AUDIT_INVALID');
  }
}

module.exports = { REQUIRED_CHECKS, ADDITIONAL_CONTROLS, assertMemberAccountSignalAudit };
