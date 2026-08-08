'use strict';

const EXACT_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const DEFAULT_REPOSITORY = 'seungjae3908-source/seungjae20260713';
const DEFAULT_ACTOR = 'seungjae3908-source';
const MAIN_REF = 'refs/heads/main';

function normalizeExactSha(value) {
  const text = String(value ?? '').trim();
  if (!EXACT_SHA_PATTERN.test(text)) return null;
  return text.toLowerCase();
}

function evaluateProductionApprovalTarget({
  targetSha,
  currentMainSha,
  repository,
  actor,
  ref,
  expectedRepository = DEFAULT_REPOSITORY,
  expectedActor = DEFAULT_ACTOR,
} = {}) {
  if (repository !== expectedRepository) {
    return { ok: false, reason: 'repository_mismatch' };
  }
  if (actor !== expectedActor) {
    return { ok: false, reason: 'approval_actor_mismatch' };
  }
  if (ref !== MAIN_REF) {
    return { ok: false, reason: 'approval_workflow_ref_not_main' };
  }

  const normalizedTarget = normalizeExactSha(targetSha);
  if (!normalizedTarget) {
    return { ok: false, reason: 'target_sha_not_exact_40_hex' };
  }
  const normalizedMain = normalizeExactSha(currentMainSha);
  if (!normalizedMain) {
    return { ok: false, reason: 'current_main_sha_invalid' };
  }
  if (normalizedTarget !== normalizedMain) {
    return { ok: false, reason: 'target_sha_not_exact_current_main' };
  }

  return {
    ok: true,
    targetSha: normalizedTarget,
    currentMainSha: normalizedMain,
  };
}

function evaluateProductionDispatchTarget({ approvalTargetSha, productionTargetSha } = {}) {
  const approval = normalizeExactSha(approvalTargetSha);
  if (!approval) return { ok: false, reason: 'approval_target_sha_invalid' };
  const production = normalizeExactSha(productionTargetSha);
  if (!production) return { ok: false, reason: 'production_target_sha_invalid' };
  if (approval !== production) {
    return { ok: false, reason: 'production_target_differs_from_approval_target' };
  }
  return { ok: true, targetSha: approval };
}

module.exports = {
  DEFAULT_ACTOR,
  DEFAULT_REPOSITORY,
  EXACT_SHA_PATTERN,
  MAIN_REF,
  evaluateProductionApprovalTarget,
  evaluateProductionDispatchTarget,
  normalizeExactSha,
};
