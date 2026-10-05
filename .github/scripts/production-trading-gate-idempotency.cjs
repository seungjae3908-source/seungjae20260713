'use strict';

const SHA40 = /^[0-9a-f]{40}$/u;

function terminalReceipt(body, marker, targetSha) {
  const lines = String(body ?? '').split(/\r?\n/u).map((line) => line.trim());
  if (!lines.includes(marker) || !lines.includes(`target_sha: ${targetSha}`)) return null;
  const statusLine = lines.find((line) => /^status:\s*\S/u.test(line));
  if (!statusLine) return null;
  const status = statusLine.replace(/^status:\s*/u, '').trim();
  return status ? { status, lines } : null;
}

async function inspectProductionTradingGateCommandIdempotency({
  github,
  context,
  issueNumber = 1555,
  targetSha,
  marker,
  desiredStatus,
  requiredLines = [],
}) {
  const target = String(targetSha ?? '').trim().toLowerCase();
  if (!SHA40.test(target)) throw new Error('PRODUCTION_TRADING_GATE_IDEMPOTENCY_TARGET_SHA_INVALID');
  if (!Number.isSafeInteger(Number(issueNumber)) || Number(issueNumber) <= 0) {
    throw new Error('PRODUCTION_TRADING_GATE_IDEMPOTENCY_ISSUE_INVALID');
  }
  if (typeof marker !== 'string' || !/^\[[A-Z0-9_]+\]$/u.test(marker)) {
    throw new Error('PRODUCTION_TRADING_GATE_IDEMPOTENCY_MARKER_INVALID');
  }
  if (typeof desiredStatus !== 'string' || !/^[A-Z0-9_]+$/u.test(desiredStatus)) {
    throw new Error('PRODUCTION_TRADING_GATE_IDEMPOTENCY_STATUS_INVALID');
  }
  if (!Array.isArray(requiredLines)
    || requiredLines.some((line) => typeof line !== 'string' || !line.trim() || line.includes('\n'))) {
    throw new Error('PRODUCTION_TRADING_GATE_IDEMPOTENCY_REQUIRED_LINES_INVALID');
  }
  if (!context?.repo?.owner || !context?.repo?.repo) {
    throw new Error('PRODUCTION_TRADING_GATE_IDEMPOTENCY_REPOSITORY_INVALID');
  }

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: Number(issueNumber),
    per_page: 100,
  });

  const receipts = comments.flatMap((comment) => {
    const receipt = terminalReceipt(comment?.body, marker, target);
    if (!receipt) return [];
    const createdAtMs = Date.parse(String(comment?.created_at ?? ''));
    const id = Number(comment?.id);
    return [{
      id: Number.isSafeInteger(id) ? id : 0,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
      status: receipt.status,
      lines: receipt.lines,
    }];
  }).sort((left, right) => (
    left.createdAtMs - right.createdAtMs || left.id - right.id
  ));

  const latest = receipts.at(-1) ?? null;
  const exactDesiredState = latest?.status === desiredStatus
    && requiredLines.every((line) => latest.lines.includes(line.trim()));
  return {
    duplicate: exactDesiredState,
    latestStatus: latest?.status ?? null,
    latestCommentId: latest?.id || null,
  };
}

module.exports = {
  inspectProductionTradingGateCommandIdempotency,
};
