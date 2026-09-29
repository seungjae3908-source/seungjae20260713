import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOperationsHealthSnapshot } from './production-operations-health.service';

test('operations health reports required read failures without throwing or mutating', async () => {
  const snapshot = await buildOperationsHealthSnapshot({
    env: {
      DEPLOY_SHA: '0ae83ffdc98e6214477c5f0e47ff8d91bdbb37df',
      LIVE_TRADING: 'false',
      AUTO_TRADING: 'false',
      REAL_ORDER_ENABLED: 'false',
      PRIVATE_TRADING_API_ALLOWED: 'false',
      executionAuthority: 'NONE',
    },
    now: () => new Date('2026-09-29T05:00:00.000Z'),
    checkDatabase: async () => { throw new Error('DB_DOWN'); },
    checkTradeStorage: async () => {},
  });

  assert.equal(snapshot.state, 'BLOCKED');
  assert.equal(snapshot.components.find((row) => row.id === 'database')?.state, 'BLOCKED');
  assert.equal(snapshot.components.find((row) => row.id === 'trade-storage')?.state, 'GREEN');
  assert.equal(snapshot.deployment.deploySha, '0ae83ffdc98e6214477c5f0e47ff8d91bdbb37df');
  assert.equal(snapshot.deployment.rollbackTargetKnown, false);
  assert.equal(snapshot.safety.readOnlySnapshot, true);
  assert.equal(snapshot.safety.providerProbePerformed, false);
  assert.equal(snapshot.safety.privateTradingRequestSent, false);
  assert.equal(snapshot.safety.orderSubmitted, false);
  assert.equal(snapshot.safety.transferPerformed, false);
  assert.equal(snapshot.safety.withdrawalPerformed, false);
});

test('operations health exposes configuration presence without returning secret values', async () => {
  const snapshot = await buildOperationsHealthSnapshot({
    env: {
      GEMINI_API_KEY: 'secret-gemini-value',
      TELEGRAM_BOT_TOKEN: 'secret-bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret-webhook',
      TELEGRAM_STOCK_CHAT_ID: '123',
      DEPLOY_SHA: 'abcdef1234567',
      PREVIOUS_DEPLOY_SHA: '1234567abcdef',
      LIVE_TRADING: 'true',
      AUTO_TRADING: 'true',
      REAL_ORDER_ENABLED: 'true',
      PRIVATE_TRADING_API_ALLOWED: 'true',
      EXECUTION_AUTHORITY: 'LIVE',
    },
    checkDatabase: async () => {},
    checkTradeStorage: async () => {},
  });

  assert.equal(snapshot.components.find((row) => row.id === 'ai-provider-config')?.state, 'GREEN');
  assert.equal(snapshot.components.find((row) => row.id === 'telegram-config')?.state, 'GREEN');
  assert.equal(snapshot.deployment.rollbackTargetKnown, true);
  assert.deepEqual(snapshot.executionGates, {
    liveTrading: true,
    autoTrading: true,
    realOrderEnabled: true,
    privateTradingApiAllowed: true,
    executionAuthority: 'LIVE',
  });
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /secret-gemini-value|secret-bot-token|secret-webhook/u);
  assert.equal(snapshot.safety.secretValuesReturned, false);
});

test('optional integration gaps degrade the snapshot but do not mark the API or database blocked', async () => {
  const snapshot = await buildOperationsHealthSnapshot({
    env: {
      DEPLOY_SHA: 'abcdef1234567',
    },
    checkDatabase: async () => {},
    checkTradeStorage: async () => { throw new Error('TRADE_SCHEMA_MISSING'); },
  });

  assert.equal(snapshot.state, 'DEGRADED');
  assert.equal(snapshot.components.find((row) => row.id === 'api-runtime')?.state, 'GREEN');
  assert.equal(snapshot.components.find((row) => row.id === 'database')?.state, 'GREEN');
  assert.equal(snapshot.components.find((row) => row.id === 'trade-storage')?.state, 'DEGRADED');
  assert.equal(snapshot.components.find((row) => row.id === 'ai-provider-config')?.state, 'DEGRADED');
  assert.equal(snapshot.components.find((row) => row.id === 'telegram-config')?.state, 'DEGRADED');
});
