import { expect, test } from '@playwright/test';
import { assessProviderBeforeRepairDeployment } from './support/production-automation-research-predeploy';

const gatesOff = {
  liveServerGateEnabled: false,
  autoServerGateEnabled: false,
};

test('a new exact-SHA repair deployment defers only provider verification to mandatory post-deploy QA', () => {
  const result = assessProviderBeforeRepairDeployment({
    provider: 'toss',
    connection: { configured: true, lastVerifiedAt: null, lastErrorCode: 'TOSS_AUTH_FAILED' },
    targetDiffersFromActiveProduction: true,
    ...gatesOff,
  });

  expect(result).toEqual({
    deploymentBlockers: [],
    postDeployVerificationBlockers: [
      'PROVIDER_NOT_VERIFIED:TOSS',
      'PROVIDER_ERROR:TOSS',
    ],
  });
});

test('the already-active SHA cannot bypass a provider verification failure', () => {
  const result = assessProviderBeforeRepairDeployment({
    provider: 'toss',
    connection: { configured: true, lastVerifiedAt: null, lastErrorCode: 'TOSS_AUTH_FAILED' },
    targetDiffersFromActiveProduction: false,
    ...gatesOff,
  });

  expect(result.deploymentBlockers).toEqual([
    'PROVIDER_NOT_VERIFIED:TOSS',
    'PROVIDER_ERROR:TOSS',
  ]);
  expect(result.postDeployVerificationBlockers).toEqual([]);
});

test('missing configuration or enabled LIVE/AUTO authority always blocks deployment', () => {
  const result = assessProviderBeforeRepairDeployment({
    provider: 'toss',
    connection: { configured: false, lastVerifiedAt: null, lastErrorCode: 'TOSS_AUTH_FAILED' },
    targetDiffersFromActiveProduction: true,
    liveServerGateEnabled: true,
    autoServerGateEnabled: true,
  });

  expect(result.deploymentBlockers).toEqual([
    'PROVIDER_NOT_CONFIGURED:TOSS',
    'LIVE_SERVER_GATE_NOT_OFF:TOSS',
    'AUTO_SERVER_GATE_NOT_OFF:TOSS',
  ]);
  expect(result.postDeployVerificationBlockers).toEqual([
    'PROVIDER_NOT_VERIFIED:TOSS',
    'PROVIDER_ERROR:TOSS',
  ]);
});
