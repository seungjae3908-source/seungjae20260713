import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  SAFE_NETWORK_STATUSES,
  STAGING_REQUIRED_STATUS,
  probeStagingTelegramNetwork,
  readStagingLoopbackHealth,
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
    health: async () => ({ runtimeSha:sha, markerSha:sha, identityMatch:true }),
  };
  const accepted = await runStagingReadOnlyProbe(common);
  assert.equal(accepted.classification, STAGING_REQUIRED_STATUS);
  assert.equal(accepted.scope, 'TELEGRAM_ONLY_STAGING_NETWORK');
  assert.equal(accepted.runtimeSha, sha);
  assert.equal(accepted.healthMarkerSha, sha);
  assert.equal(accepted.healthIdentityMatch, true);
  assert.equal(accepted.botIdentityVerified, false);
  assert.equal(accepted.roomPostingVerified, false);
  assert.equal(accepted.telegramSends, 0);
  assert.equal(accepted.financialMutations, 0);
  assert.equal(accepted.stagingDeployed, false);
  assert.equal(accepted.productionDeployed, false);

  assert.equal((await runStagingReadOnlyProbe({
    ...common, pm2Exec: () => fakeProcess('b'.repeat(40)),
  })).classification, 'STAGING_PM2_ENV_CONFLICT');
  assert.equal((await runStagingReadOnlyProbe({
    ...common, pm2Exec: () => fakeProcess('b'.repeat(40)),
    fileRead: () => 'b'.repeat(40),
    health: async () => ({
      runtimeSha:'b'.repeat(40), markerSha:'b'.repeat(40), identityMatch:true,
    }),
  })).classification, 'STAGING_RUNTIME_NOT_AT_MAIN');
  assert.equal((await runStagingReadOnlyProbe({
    ...common, pm2Exec: () => fakeProcess(null),
  })).classification, STAGING_REQUIRED_STATUS);
  assert.equal((await runStagingReadOnlyProbe({
    ...common, health: async () => null,
  })).classification, 'STAGING_RUNTIME_HEALTH_UNAVAILABLE');
  assert.equal((await runStagingReadOnlyProbe({
    ...common, fileRead: () => 'b'.repeat(40),
  })).classification, 'STAGING_RUNTIME_SHA_MISMATCH');
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
    target:sha, pm2Exec:()=> { throw new Error('SENSITIVE_EXCEPTION_MARKER_123'); },
    fileRead:()=> { throw new Error('SENSITIVE_EXCEPTION_MARKER_123'); },
    health:async()=> { throw new Error('SENSITIVE_EXCEPTION_MARKER_123'); },
    network:async()=> 'IPV4_DNS_FAILED',
  });
  assert.equal(unavailable.classification, 'STAGING_PM2_OFFLINE');
  assert.equal(unavailable.secretValuesRecorded, false);
  assert.ok(!JSON.stringify(unavailable).includes('SENSITIVE_EXCEPTION_MARKER_123'));
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

test('local Staging health proves Node env-loaded SHA but never returns its full payload', async () => {
  const input = {
    ok:true,service:'api-server',route:'/api/health',deploySha:sha,
    processDeploySha:sha,deployMarkerSha:sha,identityMatch:true,
    secretPotentiallyInWorkerState:'DO_NOT_EXPOSE_THIS_VALUE',
  };
  const read = await readStagingLoopbackHealth({
    getImpl: (url, opts, onResponse) => {
      assert.equal(url, 'http://127.0.0.1:18083/api/health');
      assert.equal(opts.timeout, 5000);
      const request = new EventEmitter();
      request.destroy = () => {};
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        onResponse(response);
        response.emit('data', Buffer.from(JSON.stringify(input)));
        response.emit('end');
      });
      return request;
    },
  });
  assert.deepEqual(read, {runtimeSha:sha, markerSha:sha, identityMatch:true});
  assert.equal(JSON.stringify(read).includes('DO_NOT_EXPOSE_THIS_VALUE'), false);
});

test('Staging health rejects invalid endpoint or untrusted process SHA', async () => {
  const simulate = body => readStagingLoopbackHealth({
    getImpl: (_url, _opts, onResponse) => {
      const request = new EventEmitter();
      request.destroy = () => {};
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        onResponse(response);
        response.emit('data', Buffer.from(JSON.stringify(body)));
        response.emit('end');
      });
      return request;
    },
  });
  assert.equal(await simulate({
    ok:true,service:'unknown',route:'/api/health',
    deploySha:sha,processDeploySha:sha,deployMarkerSha:sha,identityMatch:true,
  }), null);
  assert.equal(await simulate({
    ok:true,service:'api-server',route:'/api/health',
    deploySha:sha,processDeploySha:'invalid',deployMarkerSha:sha,identityMatch:true,
  }), null);
  const redacted = await readStagingLoopbackHealth({
    getImpl: () => { throw new Error('DO_NOT_PUBLISH_RAW_HTTP_ERROR'); },
  });
  assert.equal(redacted, null);
});

test('Staging QA reports health runtime SHA separately from supervisor environment', () => {
  assert.ok(source.includes("http://127.0.0.1:18083/api/health"));
  assert.ok(source.includes("const STAGING_PM2 = 'seungjae-staging'"));
  assert.ok(workflow.includes("'runtimeSha','healthMarkerSha','healthIdentityMatch'"));
  assert.ok(workflow.includes("Actual running Staging app SHA: "));
  assert.ok(workflow.includes("STAGING_TELEGRAM_SCOPE_NOT_READY"));
  assert.ok(!source.includes("http://0.0.0.0"));
});
