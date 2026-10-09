import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  SAFE_NETWORK_STATUSES,
  STAGING_REQUIRED_STATUS,
  probeStagingTelegramNetwork,
  runStagingReadOnlyProbe,
  stagingTelegramVerdict,
} from '../../ops/telegram-only-staging-readonly.mjs';

const workflow = fs.readFileSync('.github/workflows/telegram-only-staging-qa.yml', 'utf8');
const source = fs.readFileSync('ops/telegram-only-staging-readonly.mjs', 'utf8');
const runner = fs.readFileSync('api-server/test.mjs', 'utf8');
const pkg = JSON.parse(fs.readFileSync('api-server/package.json', 'utf8'));
const sha = 'a'.repeat(40);

function fakeProcess(current = sha) {
  return JSON.stringify([{
    name: 'seungjae-staging',
    pm2_env: { status: 'online', DEPLOY_SHA: current },
  }]);
}

test('scope contains exactly Telegram service test targets and an explicit test mode', () => {
  assert.equal(pkg.scripts['test:telegram'], 'node ./test.mjs telegram');
  assert.ok(runner.includes('telegram: ['));
  const group = runner.slice(runner.indexOf('  telegram: ['), runner.indexOf('  search: ['));
  assert.equal((group.match(/\.test\.ts/g) || []).length, 11);
  assert.ok(group.includes('src/services/telegram-notification.service.test.ts'));
  assert.ok(group.includes('src/services/telegram-market-brief.service.test.ts'));
  assert.ok(group.includes('user-broker-telegram/user-broker-telegram.service.test.ts'));
  assert.ok(group.includes('member-holdings-telegram-producer.service.test.ts'));
  assert.ok(runner.includes("'smoke', 'telegram'"));
});

test('Staging transport is fail-closed on a stale PM2 or deploy marker', async () => {
  const common = {
    target: sha,
    pm2Exec: (command, args) => {
      assert.equal(command, 'pm2');
      assert.deepEqual(args, ['jlist']);
      return fakeProcess();
    },
    fileRead: path => {
      assert.equal(path, '/srv/seungjae-staging/.deploy/current-sha');
      return sha;
    },
    network: async () => 'IPV4_TLS_READY',
  };
  const accepted = await runStagingReadOnlyProbe(common);
  assert.equal(accepted.classification, STAGING_REQUIRED_STATUS);
  assert.equal(accepted.scope, 'TELEGRAM_ONLY_STAGING_NETWORK');
  assert.equal(accepted.botIdentityVerified, false);
  assert.equal(accepted.roomPostingVerified, false);
  assert.equal(accepted.telegramSends, 0);
  assert.equal(accepted.financialMutations, 0);
  assert.equal(accepted.stagingDeployed, false);
  assert.equal(accepted.productionDeployed, false);

  assert.equal((await runStagingReadOnlyProbe({
    ...common, pm2Exec: () => fakeProcess('b'.repeat(40)),
  })).classification, 'STAGING_RUNTIME_SHA_MISMATCH');
  assert.equal((await runStagingReadOnlyProbe({
    ...common, pm2Exec: () => fakeProcess('b'.repeat(40)),
    fileRead: () => 'b'.repeat(40),
  })).classification, 'STAGING_RUNTIME_NOT_AT_MAIN');
  assert.equal((await runStagingReadOnlyProbe({
    ...common, network: async () => 'IPV4_TLS_TIMEOUT',
  })).classification, 'STAGING_TELEGRAM_NETWORK_BLOCKED');
  assert.equal(stagingTelegramVerdict({targetSha:null,pm2Online:true}), 'INVALID_EXACT_MAIN_SHA');
});

test('Staging TLS probe prefers IPv4, validates hostname, and exposes only enums', async () => {
  const success = await probeStagingTelegramNetwork({
    lookupImpl: (host, opts, done) => {
      assert.equal(host, 'api.telegram.org');
      assert.equal(opts.family, 4);
      done(null, '192.0.2.123', 4);
    },
    connectImpl: config => {
      assert.equal(config.host, 'api.telegram.org');
      assert.equal(config.servername, 'api.telegram.org');
      assert.equal(config.port, 443);
      assert.equal(config.family, 4);
      assert.equal(config.rejectUnauthorized, true);
      const socket = new EventEmitter();
      socket.authorized = true;
      socket.destroyed = false;
      socket.destroy = () => { socket.destroyed = true; };
      queueMicrotask(() => socket.emit('secureConnect'));
      return socket;
    },
  });
  assert.equal(success, 'IPV4_TLS_READY');
  assert.equal(success.includes('192.0.2'), false);
  assert.ok(SAFE_NETWORK_STATUSES.includes(success));

  const rejected = await probeStagingTelegramNetwork({
    lookupImpl: (host,opts,done) => done(new Error('confidential address')),
    connectImpl: () => { throw new Error('should not connect'); },
  });
  assert.equal(rejected, 'IPV4_DNS_FAILED');
});

test('read-only staging probe never reads Production path and never records secrets', async () => {
  assert.ok(source.includes("const STAGING_ROOT = '/srv/seungjae-staging'"));
  assert.ok(source.includes("const STAGING_PM2 = 'seungjae-staging'"));
  assert.ok(!source.includes('/opt/stock-app'));
  assert.ok(!source.includes('PROD_'));
  assert.ok(!source.includes('TELEGRAM_BOT_TOKEN'));
  assert.ok(!source.includes('sendMessage'));
  assert.ok(!source.includes('setWebhook'));
  assert.ok(!source.includes('writeFileSync'));
  const unavailable = await runStagingReadOnlyProbe({
    target:sha, pm2Exec:()=> { throw new Error('secret'); },
    fileRead:()=> { throw new Error('secret'); },
    network:async()=> 'IPV4_DNS_FAILED',
  });
  assert.equal(unavailable.classification, 'STAGING_PM2_OFFLINE');
  assert.ok(!JSON.stringify(unavailable).includes('secret'));
});

test('owner command is exact-current-main, protected in isolated staging environment', () => {
  for (const marker of [
    'environment: staging',
    "github.event.issue.number == 1555",
    "github.event.comment.user.login == 'seungjae3908-source'",
    "github.event.comment.author_association == 'OWNER'",
    '/run-telegram-staging-qa ',
    'test "$GITHUB_SHA" = "$TARGET_SHA"',
    'test "$TARGET_SHA" = "$(git rev-parse origin/main)"',
    'STAGING_SSH_PRIVATE_KEY: ${{ secrets.STAGING_SSH_PRIVATE_KEY }}',
    'StrictHostKeyChecking=yes',
    'TELEGRAM_STAGING_READONLY_EXECUTE=true',
    'TELEGRAM_STAGING_NETWORK_ONLY_PASS',
    'TELEGRAM_STAGING_SCOPE_NOT_READY',
    'pnpm --dir api-server test:telegram',
    'Staging deployments / Production deployments: 0 / 0',
    'Actual bot identity / six-room posting verified: false / false',
    'This scoped QA NEVER replaces required release-wide Staging/CI gates.',
  ]) {
    assert.ok(workflow.includes(marker), marker);
  }
  for (const forbidden of [
    'PROD_SSH_','PROD_DATABASE_URL','LIVE_TRADING=true',
    'sendMessage','setWebhook','pm2 restart','pm2 reload',
    'ops/deploy-staging.sh','staging-readiness.yml','playwright test',
    'run_full_validation: false',
  ]) {
    assert.ok(!workflow.includes(forbidden), forbidden);
  }
  assert.ok(workflow.includes('node --test'));
  assert.ok(workflow.includes('api-server/src/features/user-broker-telegram/**'));
  assert.ok(workflow.includes('secretValuesRecorded !== false'));
});
