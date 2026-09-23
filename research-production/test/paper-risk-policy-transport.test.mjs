import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildTaskPlan, PROFILES, runResearchCycle, sanitizeChildEnv } from '../src/engine.mjs';
import { runPaperForwardScheduleCli } from '../../market-prediction-lab/scripts/run-paper-forward-schedule.js';
import { loadValidatedAuthoritativePaperRuntimePackage } from '../../market-prediction-lab/src/authoritative-paper-runtime-package-v1.js';
import { runPaperForwardScheduledInvocation } from '../../market-prediction-lab/src/paper-forward-schedule-runtime-v1.js';

const SHA = 'a'.repeat(40);
const KEY = 'PAPER_FORWARD_RISK_POLICY_RECORD_PATH';
const DECISION_KEY = 'PAPER_FORWARD_RISK_POLICY_DECISION_PATH';
const COST_KEY = 'PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH';
const SAFETY_KEYS = ['LIVE_TRADING', 'REAL_ORDER_ENABLED', 'PRIVATE_API_ENABLED',
  'PRIVATE_ACCOUNT_ACCESS', 'PRIVATE_TRADING_API_ALLOWED', 'ORDER_AUTHORITY'];
const EXPLICIT_PATH = resolve(tmpdir(), 'owner supplied policy.record');
const DECISION_PATH = resolve(tmpdir(), 'owner approved policy decision.json');
const COST_PATH = resolve(tmpdir(), 'owner supplied cost.record');

function plan(env = {}, profile = 'forward') {
  return buildTaskPlan({ profile, stateRoot: resolve(tmpdir(), 'research-state'),
    researchSha: SHA, activationAtMs: 12345, env });
}

function paper(env = {}) {
  return plan(env).find((task) => task.id === 'paper-forward');
}

test('T01 absent and empty canonical paths stay absent without a default', () => {
  for (const env of [{}, { [KEY]: '' }]) assert.equal(Object.hasOwn(paper(env).env, KEY), false);
});

test('T02 explicit normalized absolute path is preserved exactly', () => {
  assert.equal(paper({ [KEY]: EXPLICIT_PATH }).env[KEY], EXPLICIT_PATH);
});

test('T03 relative, non-normalized and control-character paths fail before launch', () => {
  for (const value of ['relative/policy.record', `${EXPLICIT_PATH} `,
    ` ${EXPLICIT_PATH}`, `${EXPLICIT_PATH}\n`, `${EXPLICIT_PATH}\r`, `${EXPLICIT_PATH}\0`,
    `${dirname(EXPLICIT_PATH)}/../policy.record`, 123]) {
    assert.throws(() => paper({ [KEY]: value }), /normalized absolute path/);
  }
});

test('T04 legacy variable alone never supplies the canonical reader path', () => {
  const env = { GENERIC_RISK_POLICY_LIVE_RECORD_PATH: EXPLICIT_PATH };
  assert.equal(Object.hasOwn(paper(env).env, KEY), false);
  assert.equal(Object.hasOwn(paper(env).env, 'GENERIC_RISK_POLICY_LIVE_RECORD_PATH'), false);
});

test('T05 transport is confined to Paper and excluded from the general allowlist', () => {
  const env = { [KEY]: EXPLICIT_PATH };
  assert.equal(Object.hasOwn(sanitizeChildEnv(env), KEY), false);
  for (const task of plan(env, 'all')) {
    assert.equal(Object.hasOwn(task.env, KEY), task.kind === 'paper');
  }
});

test('T06 Paper child retains all six disabled trading/private safety flags', () => {
  for (const key of SAFETY_KEYS) assert.equal(paper({ [KEY]: EXPLICIT_PATH }).env[key], 'false');
});

test('explicit supplemental cost path reaches Paper only; missing stays missing and unsafe paths fail', () => {
  for (const env of [{}, { [COST_KEY]: '' }]) {
    assert.equal(Object.hasOwn(paper(env).env, COST_KEY), false);
  }
  const env = { [COST_KEY]: COST_PATH };
  assert.equal(paper(env).env[COST_KEY], COST_PATH);
  assert.equal(Object.hasOwn(sanitizeChildEnv(env), COST_KEY), false);
  for (const task of plan(env, 'all')) {
    assert.equal(Object.hasOwn(task.env, COST_KEY), task.kind === 'paper');
  }
  for (const value of ['relative/cost.record', `${COST_PATH} `, `${COST_PATH}\n`,
    `${dirname(COST_PATH)}/../cost.record`, 123]) {
    assert.throws(() => paper({ [COST_KEY]: value }), /normalized absolute path/);
  }
  for (const key of SAFETY_KEYS) assert.equal(paper(env).env[key], 'false');
});

test('T07 actual child transport reads no record and preserves direct-spawn path bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-risk-path-child-'));
  const repoRoot = join(root, 'repo');
  const stateRoot = join(root, 'state');
  const path = join(root, 'owner path with \'" quotes', 'absent-policy.record');
  const lab = join(repoRoot, 'market-prediction-lab');
  const required = new Set(['package.json']);
  for (const tasks of Object.values(PROFILES)) for (const task of tasks) {
    for (const arg of task.args) required.add(arg);
  }
  const probe = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify([KEY, COST_KEY, ...SAFETY_KEYS])}.map(key => [key, process.env[key] ?? null]))));\n`;
  try {
    for (const relative of required) {
      const target = join(lab, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, relative === 'package.json' ? '{}\n' : probe);
    }
    for (const relative of [
      'packages/strategy-hypothesis/package.json',
      'packages/strategy-hypothesis/src/index.js',
      'packages/strategy-hypothesis/src/contract.js',
      'packages/external-research/package.json',
      'packages/external-research/src/index.js',
      'packages/external-research/src/contract.js',
    ]) {
      const target = join(repoRoot, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, relative.endsWith('.json') ? '{}\n' : 'export const fixture = true;\n');
    }
    await assert.rejects(access(path), { code: 'ENOENT' });
    const result = await runResearchCycle({ repoRoot, stateRoot, researchSha: SHA,
      profile: 'forward', env: { PATH: process.env.PATH, [KEY]: path, [COST_KEY]: COST_PATH },
      activationAtMs: 12345, verifyGitHead: false });
    assert.equal(result.status, 'complete');
    for (const row of result.results) {
      const seen = JSON.parse(await readFile(row.stdoutPath, 'utf8'));
      assert.equal(seen[KEY], row.id === 'paper-forward' ? path : null);
      assert.equal(seen[COST_KEY], row.id === 'paper-forward' ? COST_PATH : null);
      for (const key of SAFETY_KEYS) assert.equal(seen[key], 'false');
    }
    await assert.rejects(access(path), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('T08 existing forward invocation, schedule and canonical Swing identity stay fixed', async () => {
  const tasks = plan({ [KEY]: EXPLICIT_PATH });
  assert.deepEqual(tasks.map((task) => task.id), ['shadow-forward', 'paper-forward']);
  const task = tasks[1];
  assert.deepEqual(task.args, ['scripts/run-paper-forward-schedule.js']);
  assert.equal(task.env.PAPER_FORWARD_SCHEDULE_ACTIVE, 'true');
  assert.equal(task.env.PAPER_FORWARD_TRIGGER_SOURCE, 'cron');
  assert.equal(task.env.PAPER_FORWARD_ACTIVATION_AT_MS, '12345');
  assert.equal(task.env.PAPER_FORWARD_RESEARCH_SHA, SHA);
  assert.equal(task.timeoutMs, 20 * 60_000);
  assert.deepEqual(task.acceptedExitCodes, [0, 2]);
  const timer = await readFile(new URL('../deploy/research-production-forward.timer', import.meta.url), 'utf8');
  assert.match(timer, /^OnCalendar=\*-\*-\* \*:11:00 UTC$/mu);
  assert.match(timer, /^Unit=research-production@forward\.service$/mu);
  const profiles = await readFile(new URL('../../api-server/src/services/scanner-strategy-profile.service.ts', import.meta.url), 'utf8');
  assert.match(profiles, /CRYPTO_FUTURES:\s*\{\s*SCALP:[^\n]+\n\s*SWING:\s*\{ primary: '60m', confirm: \['4H'\] \}/u);
});

test('T09/T10 real reader and producer keep missing records blocked without economic credit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-risk-path-missing-'));
  const previousExitCode = process.exitCode;
  try {
    const runtimePackage = await loadValidatedAuthoritativePaperRuntimePackage();
    for (const configured of [false, true]) {
      const explicitPath = join(root, 'missing-owner-policy.record');
      const task = paper(configured ? { [KEY]: explicitPath } : {});
      let reader;
      let scheduledResult;
      const policyResults = [];
      const packageWithReaderCapture = { ...runtimePackage,
        createAuthoritativePaperNaturalCycleEvidenceSourceWiring(input) {
          reader = input.sources.riskPolicyRecordForCard;
          return runtimePackage.createAuthoritativePaperNaturalCycleEvidenceSourceWiring(input);
        } };
      const output = await runPaperForwardScheduleCli({ ...task.env,
        PAPER_FORWARD_ROOT: join(root, configured ? 'configured' : 'absent') }, {
        authoritativePaperPackageLoader: async () => packageWithReaderCapture,
        publicEvidenceProvider: { async collectPublicEvidence() {
          const producer = runtimePackage.createAuthoritativePaperGenericRiskPolicyProducer({
            readCanonicalRecord: reader,
          });
          const policy = await producer({ market: 'CRYPTO_FUTURES', symbol: 'TRANSPORT_TEST',
            strategyScope: 'CRYPTO_FUTURES_SWING_V1_LONG', researchCodeSha: SHA });
          policyResults.push(policy);
          return { status: policy.status, candidates: [], exits: [], blocker: policy.blockers[0] };
        } },
        async runScheduledInvocation(input) {
          scheduledResult = await runPaperForwardScheduledInvocation(input);
          return scheduledResult;
        },
      });
      assert.ok(policyResults.length > 0);
      for (const policy of policyResults) {
        assert.equal(policy.status, 'BLOCKED_DATA');
        assert.equal(policy.policyEvidence, null);
        assert.deepEqual(policy.blockers, ['RISK_POLICY_CANONICAL_RECORD_MISSING']);
      }
      assert.equal(output.status, 'BLOCKED_DATA');
      assert.equal(output.mutationCount, 0);
      assert.equal(output.paperTradeOutcomeAccumulationEnabled, true);
      assert.equal(output.paperTradeOutcomeAccumulating, false);
      assert.equal(output.privateRequestCount, 0);
      assert.equal(output.financialMutationCount, 0);
      assert.equal(output.orderCount, 0);
      const connection = scheduledResult.authoritativeRuntimeStageEvidenceConnection;
      assert.equal(connection.sampleCredit, 0);
      assert.equal(connection.executionRealismCredit, 0);
      assert.equal(connection.profitabilityCredit, 0);
      const publication = scheduledResult.frozenCandidatePerformancePublication;
      assert.equal(publication.evidenceStatus, 'BLOCKED');
      const artifact = JSON.parse(await readFile(
        join(root, configured ? 'configured' : 'absent', publication.artifactRelativePath), 'utf8'));
      assert.equal(artifact.status, 'BLOCKED');
      assert.equal(artifact.manualEconomicCredit, 0);
      assert.equal(artifact.backfillCredit, 0);
      assert.equal(artifact.replayCredit, 0);
      assert.equal(artifact.syntheticCredit, 0);
      assert.equal(artifact.sampleCredit, 0);
      assert.equal(artifact.executionRealismCredit, 0);
      assert.equal(artifact.profitabilityCredit, 0);
      assert.equal(artifact.PROFITABILITY_PROVEN, false);
      for (const field of ['candidateMatchedN', 'Entry_N', 'Settlement_N', 'Gross_PnL', 'Net_PnL']) {
        assert.equal(artifact[field], null);
      }
      for (const stage of Object.values(output.canonicalNaturalStageEvidence.stageCounts)) {
        assert.equal(stage.count, null);
        assert.equal(stage.naturalCredit, 0);
      }
      await assert.rejects(access(explicitPath), { code: 'ENOENT' });
    }
  } finally {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
  }
});


test('approved risk-policy decision path is transported to Paper only and never competes with an explicit record', () => {
  const task = paper({ [DECISION_KEY]: DECISION_PATH });
  assert.equal(task.env[DECISION_KEY], DECISION_PATH);
  assert.equal(Object.hasOwn(task.env, KEY), false);
  assert.equal(Object.hasOwn(sanitizeChildEnv({ [DECISION_KEY]: DECISION_PATH }), DECISION_KEY), false);
  for (const row of plan({ [DECISION_KEY]: DECISION_PATH }, 'all')) {
    assert.equal(Object.hasOwn(row.env, DECISION_KEY), row.kind === 'paper');
  }
  assert.throws(
    () => paper({ [KEY]: EXPLICIT_PATH, [DECISION_KEY]: DECISION_PATH }),
    /canonical risk policy source is ambiguous/u,
  );
  for (const value of ['relative/decision.json', `${DECISION_PATH} `, `${DECISION_PATH}\n`,
    `${dirname(DECISION_PATH)}/../decision.json`, 123]) {
    assert.throws(
      () => paper({ [DECISION_KEY]: value }),
      /risk policy decision path must be a normalized absolute path/u,
    );
  }
});

test('Research Paper materializes the owner-approved decision freshly at canonical reader call time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-risk-decision-materialization-'));
  const previousExitCode = process.exitCode;
  const decisionPath = join(root, 'approved-decision.json');
  try {
    const approvedDecision = JSON.parse(await readFile(
      new URL('../../market-prediction-lab/config/paper-risk-policy/natural-paper-btcusdt-v1.json', import.meta.url),
      'utf8',
    ));
    await writeFile(decisionPath, JSON.stringify(approvedDecision));
    const task = paper({ [DECISION_KEY]: decisionPath });
    const runtimePackage = await loadValidatedAuthoritativePaperRuntimePackage();
    let reader = null;
    const policyResults = [];
    const packageWithReaderCapture = {
      ...runtimePackage,
      createAuthoritativePaperNaturalCycleEvidenceSourceWiring(input) {
        reader = input.sources.riskPolicyRecordForCard;
        return runtimePackage.createAuthoritativePaperNaturalCycleEvidenceSourceWiring(input);
      },
    };
    const output = await runPaperForwardScheduleCli({
      ...task.env,
      PAPER_FORWARD_ROOT: join(root, 'paper'),
    }, {
      authoritativePaperPackageLoader: async () => packageWithReaderCapture,
      publicEvidenceProvider: {
        async collectPublicEvidence() {
          assert.equal(typeof reader, 'function');
          const producer = runtimePackage.createAuthoritativePaperGenericRiskPolicyProducer({
            readCanonicalRecord: reader,
          });
          const policy = await producer({
            market: 'CRYPTO_FUTURES',
            symbol: 'BTCUSDT',
            strategyScope: 'CRYPTO_FUTURES_SWING_V1_LONG',
            researchCodeSha: SHA,
          });
          policyResults.push(policy);
          return {
            status: 'BLOCKED_DATA',
            candidates: [],
            exits: [],
            blocker: 'TEST_STOP_AFTER_POLICY_READ',
          };
        },
      },
    });
    assert.ok(policyResults.length > 0);
    for (const policy of policyResults) {
      assert.equal(policy.status, 'PRESENT');
      assert.equal(policy.policyEvidence?.policyId, 'NATURAL_PAPER_BTCUSDT_CRYPTO_FUTURES_V1');
      assert.equal(policy.policyEvidence?.researchCodeSha, SHA);
      assert.equal(policy.policyEvidence?.riskPercent, approvedDecision.riskPercent);
      assert.equal(policy.policyEvidence?.requestedLeverage, approvedDecision.requestedLeverage);
      assert.equal(policy.policyEvidence?.maximumLeverage, approvedDecision.maximumLeverage);
      assert.equal(policy.policyEvidence?.marginMode, approvedDecision.marginMode);
      assert.ok(Date.now() - policy.policyEvidence.observedAtMs < 30_000);
    }
    assert.equal(output.status, 'BLOCKED_DATA');
    assert.equal(output.privateRequestCount, 0);
    assert.equal(output.financialMutationCount, 0);
    assert.equal(output.orderCount, 0);
  } finally {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
  }
});
