import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/staging-account-readonly-evidence.yml', import.meta.url),
);
const evidenceSourcePath = fileURLToPath(
  new URL('../../api-server/src/features/account-readonly/staging-account-readonly-no-db-evidence.ts', import.meta.url),
);

test('private account evidence keeps GitHub-hosted isolation and uses Staging only as fixed egress', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const evidenceSource = readFileSync(evidenceSourcePath, 'utf8');

  expect(workflow).toContain('runs-on: ubuntu-latest');
  expect(workflow).not.toContain('runs-on: [self-hosted');
  expect(workflow).toContain('EXPECTED_EGRESS_IP: ${{ vars.STAGING_ACCOUNT_EVIDENCE_EGRESS_IP }}');
  expect(workflow).not.toContain('${{ runner.temp }}');
  expect(workflow).toContain('SSH_KEY_PATH: ${{ github.workspace }}/.account-evidence-id_ed25519');
  expect(workflow).toContain('SSH_KNOWN_HOSTS_PATH: ${{ github.workspace }}/.account-evidence-known_hosts');
  expect(workflow).toContain('SSH_CONTROL_SOCKET: ${{ github.workspace }}/.account-evidence-ssh.sock');
  expect(workflow).toContain('https://api.ipify.org');
  expect(workflow).toContain('"$ACTUAL_EGRESS_IP" == "$EXPECTED_EGRESS_IP"');
  expect(workflow).toContain('StrictHostKeyChecking=yes');
  expect(workflow).toContain('STAGING_SSH_KNOWN_HOSTS: ${{ secrets.STAGING_SSH_KNOWN_HOSTS }}');

  expect(workflow).toContain('-L 127.0.0.1:18443:openapi.tossinvest.com:443');
  expect(workflow).toContain('-L 127.0.0.1:18444:api.upbit.com:443');
  expect(workflow).toContain('-L 127.0.0.1:18445:api.bitget.com:443');

  const egressIndex = workflow.indexOf('- name: Require provider-allowlisted Staging egress IP');
  const tunnelIndex = workflow.indexOf('- name: Open TLS-preserving provider egress tunnels');
  const evidenceIndex = workflow.indexOf('- name: Run canonical Toss Upbit Bitget no-DB read-only evidence');
  const postIdentityIndex = workflow.indexOf('- name: Re-prove current main and Staging egress unchanged');
  const firstProviderSecretIndex = workflow.indexOf('STAGING_TOSS_CLIENT_ID: ${{ secrets.');

  expect(egressIndex).toBeGreaterThanOrEqual(0);
  expect(tunnelIndex).toBeGreaterThan(egressIndex);
  expect(evidenceIndex).toBeGreaterThan(tunnelIndex);
  expect(firstProviderSecretIndex).toBeGreaterThan(evidenceIndex);
  expect(postIdentityIndex).toBeGreaterThan(evidenceIndex);
  expect(workflow.slice(0, evidenceIndex)).not.toContain('STAGING_TOSS_CLIENT_ID: ${{ secrets.');
  expect(workflow.slice(0, evidenceIndex)).not.toContain('STAGING_UPBIT_ACCESS_KEY: ${{ secrets.');
  expect(workflow.slice(0, evidenceIndex)).not.toContain('STAGING_BITGET_API_KEY: ${{ secrets.');
  expect(workflow).toContain('require_success post-identity "$POST_IDENTITY"');
  expect(workflow).toContain('- name: Close provider egress tunnels and clean workspace');

  expect(evidenceSource).toContain("import https from 'node:https';");
  expect(evidenceSource).toContain('[TOSS_API_ORIGIN, 18443]');
  expect(evidenceSource).toContain('[UPBIT_API_ORIGIN, 18444]');
  expect(evidenceSource).toContain('[BITGET_API_ORIGIN, 18445]');
  expect(evidenceSource).toContain("hostname: '127.0.0.1'");
  expect(evidenceSource).toContain('servername: url.hostname');
  expect(evidenceSource).toContain("headers.set('Host', url.host);");
  expect(evidenceSource).toContain("headers.set('Content-Length', String(Buffer.byteLength(body)));");
  expect(evidenceSource).toContain('rejectUnauthorized: true');
  expect(evidenceSource).toContain("providerTransport: 'STAGING_SSH_TCP_TUNNEL'");
  expect(evidenceSource).toContain('tlsTerminatedOnEvidenceRunner: true');
  expect(evidenceSource).toContain('providerTlsPayloadTraversesStagingHost: true');
  expect(evidenceSource).toContain('providerSecretPlaintextExposedToStagingHost: false');
  expect(evidenceSource).not.toContain('return fetch(input, init);');
});