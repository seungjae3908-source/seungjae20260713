import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/staging-account-readonly-evidence.yml', import.meta.url),
);

test('staging account evidence cannot call private providers from a dynamic GitHub-hosted runner', () => {
  const source = readFileSync(workflowPath, 'utf8');

  expect(source).toContain('runs-on: [self-hosted, linux, staging-account-egress]');
  expect(source).not.toContain('runs-on: ubuntu-latest');
  expect(source).toContain('EXPECTED_EGRESS_IP: ${{ vars.STAGING_ACCOUNT_EVIDENCE_EGRESS_IP }}');
  expect(source).toContain('RUNNER_ENVIRONMENT_VALUE: ${{ runner.environment }}');
  expect(source).toContain("[[ \"$RUNNER_ENVIRONMENT_VALUE\" == 'self-hosted' ]]");
  expect(source).toContain('https://api.ipify.org');
  expect(source).toContain('"$ACTUAL_EGRESS_IP" == "$EXPECTED_EGRESS_IP"');

  const gateIndex = source.indexOf('- name: Require fixed egress and exact current main');
  const evidenceIndex = source.indexOf('- name: Run canonical Toss Upbit Bitget no-DB read-only evidence');
  const firstProviderSecretIndex = source.indexOf('STAGING_TOSS_CLIENT_ID: ${{ secrets.');

  expect(gateIndex).toBeGreaterThanOrEqual(0);
  expect(evidenceIndex).toBeGreaterThan(gateIndex);
  expect(firstProviderSecretIndex).toBeGreaterThan(evidenceIndex);

  expect(source).not.toContain('STAGING_SSH_PRIVATE_KEY');
  expect(source).not.toContain('STAGING_SSH_HOST');
  expect(source).toContain('- name: Clean self-hosted evidence workspace');
});
