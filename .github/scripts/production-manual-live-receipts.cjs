'use strict';

function field(body, name, separator = ':') {
  const lines = String(body ?? '').split(/\r?\n/u);
  const prefix = name + separator;
  const values = lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).trim());
  return values.length === 1 ? values[0] : null;
}

function parseManualReceipt(comment, kind, targetSha, deploymentCompletedAt) {
  if (comment?.user?.login !== 'github-actions[bot]' || comment?.user?.type !== 'Bot') return null;
  const at = Date.parse(String(comment.created_at ?? ''));
  const deploymentAt = Date.parse(deploymentCompletedAt);
  if (!/^[a-f0-9]{40}$/u.test(targetSha) || !Number.isFinite(deploymentAt)
    || !Number.isFinite(at) || at < deploymentAt) return null;
  const body = String(comment.body ?? '');
  const spot = kind === 'spot';
  if (!['spot', 'futures'].includes(kind)
    || body.split(/\r?\n/u)[0] !== (spot ? '[PRODUCTION_LIVE_TRADING_GATE]' : '[PRODUCTION_FUTURES_LIVE_TRADING_GATE]')
    || field(body, 'status') !== (spot ? 'ACTIVATED_SPOT_LIVE_LIMITED_MANUAL' : 'ACTIVATED_FUTURES_LIVE_LIMITED_MANUAL')
    || field(body, 'target_sha') !== targetSha
    || field(body, 'AUTO_TRADING', '=') !== 'false'
    || field(body, 'LIVE_AUTOMATIC_TRADING_ENABLED', '=') !== 'false'
    || field(body, 'REAL_ORDER_SUBMITTED', '=') !== 'false') return null;
  if (spot && (field(body, 'providers') !== 'kiwoom,toss,upbit'
    || field(body, 'executionAuthority', '=') !== 'SPOT_LIVE_LIMITED')) return null;
  const leverage = spot ? null : field(body, 'max_leverage');
  if (!spot && (field(body, 'provider') !== 'bitget' || !/^[2-7]$/u.test(leverage ?? '')
    || field(body, 'margin_mode') !== 'isolated'
    || field(body, 'FUTURES_LIVE_EXECUTION_AUTHORITY', '=') !== 'FUTURES_LIVE_LIMITED')) return null;
  const run = field(body, 'workflow_run');
  if (!/^[1-9][0-9]*$/u.test(run ?? '') || !Number.isSafeInteger(Number(run))) return null;
  return { commentId: comment.id, runId: Number(run), createdAtMs: at, leverage };
}

async function inspectManualLiveReceipts({ github, context, comments, targetSha, deploymentCompletedAt }) {
  const results = {};
  for (const kind of ['spot', 'futures']) {
    const candidates = comments.map((comment) => parseManualReceipt(comment, kind, targetSha, deploymentCompletedAt))
      .filter((receipt) => receipt && (kind !== 'futures' || receipt.leverage === '7'))
      // ALL4 needs the current global maximum 7x receipt. A parseable 3x
      // limited-manual receipt cannot attest the administrator's 7x policy.
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    for (const receipt of candidates) {
      const { data: run } = await github.rest.actions.getWorkflowRun({
        ...context.repo, run_id: receipt.runId,
      });
      const expectedPath = kind === 'spot' ? '.github/workflows/production-live-trading-gate.yml'
        : '.github/workflows/production-futures-live-trading-gate.yml';
      if (run.path === expectedPath && run.head_sha === targetSha && run.head_branch === 'main'
        && run.event === 'issue_comment' && run.status === 'completed' && run.conclusion === 'success'
        && Date.parse(run.created_at) >= Date.parse(deploymentCompletedAt)
        && Date.parse(run.updated_at) >= receipt.createdAtMs) {
        results[kind] = receipt;
        break;
      }
    }
    if (!results[kind]) throw new Error(`AUTOMATIC_TRADING_EXACT_${kind.toUpperCase()}_MANUAL_RECEIPT_REQUIRED`);
  }
  return results;
}

module.exports = { parseManualReceipt, inspectManualLiveReceipts };
