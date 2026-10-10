import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/research-market-watch-runtime-audit.yml', 'utf8');
const script = readFileSync('research-production/deploy/read-only-market-watch-evidence.sh', 'utf8');

test('runtime evidence requires exact owner, canonical Hub and two pinned SHAs', () => {
  for (const token of [
    "github.event.issue.number == 1102",
    "github.event.comment.user.login == github.repository_owner",
    "github.event.comment.author_association == 'OWNER'",
    "/audit-market-watch ",
    "WATCH_AUDIT_MAIN_MOVED",
    "WATCH_AUDIT_RELEASE_NOT_ANCESTOR",
    "WATCH_AUDIT_ACTIVATION_RUN_MISMATCH",
    "RESEARCH_MARKET_WATCH_ACTIVATION",
    "run.conclusion!=='success'",
    "StrictHostKeyChecking=yes",
  ]) assert.ok(workflow.includes(token), token);
});

test('read-only wrapper matches independently attested installed Research SHA and worker', () => {
  for (const token of [
    'RESEARCH_SHA',
    'readlink -f "$CURRENT"',
    'git -c "safe.directory=$RELEASE"',
    'RESEARCH_CODE_SHA=$RESEARCH_SHA',
    'LIVE_TRADING=false PRIVATE_API_ENABLED=false ORDER_AUTHORITY=false',
    'systemctl is-active --quiet "$UNIT"',
    'systemctl is-enabled --quiet "$UNIT"',
    'lightweight-market-watch-status.mjs',
    'lightweight-market-watch-preflight.mjs',
    'WATCH_LAST_CYCLE_AGE_MS',
    'WATCH_CADENCE_SAMPLES',
    'WATCH_MEMORY_CURRENT_BYTES',
    'WATCH_FOUR_MARKET_FULL_FEED_PROVEN=false',
    'WATCH_24H_UPTIME_PROVEN=false',
    'WATCH_EXECUTION_AUTHORITY=NONE',
  ]) assert.ok(script.includes(token), token);
});

test('no server mutations, private provider calls, or automatic audit schedule', () => {
  assert.ok(!/^\s+schedule:/m.test(workflow));
  const executable = script.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  for (const disallowed of [
    /\bsystemctl\s+(?:start|stop|restart|enable|disable|daemon-reload)\b/,
    /\bpm2\s+(?:start|stop|restart|reload|delete)\b/,
    /\b(?:curl|wget|psql|scp|rsync)\s/,
    /\bgit\s+(?:checkout|push|pull|reset|fetch)\b/,
    /\b(?:chmod|chown|mv|cp|rm|touch|truncate|tee|install)\s/,
  ]) assert.doesNotMatch(executable, disallowed);
  assert.ok(workflow.includes('production_server_write: 0'));
  assert.ok(workflow.includes('production_db_mutation: 0'));
  assert.ok(workflow.includes('paper_orders: 0'));
  assert.ok(workflow.includes('real_orders: 0'));
});

test('audit cannot claim any economic, four-market or 24-hour proof', () => {
  for (const evidence of [
    'continuous_24h_uptime_proven: false',
    'four_market_full_feed_proven: false',
    'paper_execution_proven: false',
    'profitability_proven: false',
    'execution_authority: NONE',
  ]) assert.ok(workflow.includes(evidence), evidence);
  assert.ok(script.includes("watch.continuous24hProven !== false"));
  assert.ok(script.includes("pre.independentlyVerified24hUptime !== false"));
  assert.ok(script.includes("pre.fourMarketWholeUniverseProven !== false"));
});

test('GitHub Actions expressions are complete, and step outputs do not sit in job env', () => {
  assert.doesNotMatch(workflow, /\$\{\{[^}\n]*\}(?!\})/);
  assert.ok(workflow.includes('AUTHORIZED_RESEARCH_SHA:'));
  assert.ok(workflow.includes('AUTHORIZED_MAIN_SHA:'));
  assert.ok(workflow.includes(">> \"$GITHUB_ENV\""));
  assert.ok(workflow.includes('if: success()'));
  assert.ok(workflow.includes('if: failure()'));
});
