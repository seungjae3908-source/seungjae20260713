import { execFileSync } from 'node:child_process';
import { probeManualPaperCanonicalRuntimeReadiness } from '../src/services/manual-paper-canonical-runtime-readiness.service';

const ENV_KEYS = Object.freeze([
  'DEPLOY_SHA',
  'PAPER_CANONICAL_OWNER_BRIDGE_ENABLED',
  'PAPER_CANONICAL_FORWARD_OBSERVER_ARTIFACT_ROOT',
  'PAPER_CANONICAL_VALIDATION_RECEIPT_ROOT',
  'PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_MS',
  'PAPER_FORWARD_STATE_ROOT',
  'PAPER_FORWARD_ROOT',
  'PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH',
  'PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256',
  'APP_ENV',
  'LIVE_TRADING',
  'AUTO_TRADING',
  'REAL_ORDER_ENABLED',
  'PRIVATE_TRADING_API_ALLOWED',
  'executionAuthority',
  'EXECUTION_AUTHORITY',
] as const);

function argument(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
}

function blocked(blocker: string) {
  return Object.freeze({
    schemaVersion: 'manual-paper-canonical-runtime-readiness-remote-v1',
    status: 'BLOCKED',
    readyForActivationReview: false,
    activationApplied: false,
    runtimeProcessReady: false,
    bridgeEnabled: false,
    blockers: Object.freeze([blocker]),
    evidenceCounts: Object.freeze({
      naturalPositions: 0,
      naturalSettlements: 0,
      fullCostReadyPositions: 0,
      durableSettlementPackets: 0,
      canonicalRebinds: 0,
    }),
    safety: Object.freeze({
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      executionAuthority: 'NONE',
      financialMutationPerformed: false,
      environmentMutationPerformed: false,
    }),
  });
}

const expectedMainSha = argument('expected-main-sha').toLowerCase();
const pm2Name = argument('pm2-name') || 'stock-app';

let processes: any[];
try {
  processes = JSON.parse(execFileSync('pm2', ['jlist'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })) as any[];
} catch {
  process.stdout.write(`${JSON.stringify(blocked('PAPER_CANONICAL_PM2_READ_FAILED'), null, 2)}\n`);
  process.exit(0);
}

const matches = processes.filter((item) => item?.name === pm2Name && item?.pm2_env);
if (matches.length !== 1) {
  process.stdout.write(
    `${JSON.stringify(blocked(
      matches.length === 0
        ? 'PAPER_CANONICAL_PM2_PROCESS_NOT_FOUND'
        : 'PAPER_CANONICAL_PM2_PROCESS_AMBIGUOUS',
    ), null, 2)}\n`,
  );
  process.exit(0);
}

const selected = matches[0];
const runtimeEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
  const value = selected.pm2_env?.[key];
  if (value !== undefined && value !== null && typeof value !== 'object') {
    runtimeEnv[key] = String(value);
  }
}

const result = await probeManualPaperCanonicalRuntimeReadiness({
  expectedMainSha,
  env: runtimeEnv,
});

const online = selected.pm2_env?.status === 'online';
const blockers = online
  ? [...result.blockers]
  : [...result.blockers, 'PAPER_CANONICAL_PM2_PROCESS_NOT_ONLINE'];
const readyForActivationReview = result.readyForActivationReview && online;

process.stdout.write(`${JSON.stringify({
  ...result,
  schemaVersion: 'manual-paper-canonical-runtime-readiness-remote-v1',
  status: readyForActivationReview ? 'READY_FOR_ACTIVATION_REVIEW' : 'BLOCKED',
  readyForActivationReview,
  runtimeProcessReady: online,
  blockers,
  activationApplied: false,
}, null, 2)}\n`);
