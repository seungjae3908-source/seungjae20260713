import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/server-readonly-research-18090-diagnostics.yml', import.meta.url),
);

test('Research 18090 diagnostics reuse the existing owner command and stay read-only', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  expect(workflow).toContain('name: Read-only Shared Server Research 18090 Diagnostics');
  expect(workflow).toContain('pull_request:');
  expect(workflow).toContain('issue_comment:');
  expect(workflow).toContain("github.event.issue.number == 23");
  expect(workflow).toContain("github.event.issue.title == 'Staging Readiness Control'");
  expect(workflow).toContain("startsWith(github.event.comment.body, '/run-server-diagnostics ')");
  expect(workflow).not.toContain('/run-staging-research-18090-');
  expect(workflow).not.toContain('workflow_dispatch:');

  expect(workflow).toContain("author !== 'seungjae3908-source'");
  expect(workflow).toContain("association !== 'OWNER'");
  expect(workflow).toContain("branch: 'main'");
  expect(workflow).toContain('targetSha !== currentMain');
  expect(workflow).toContain("'application-ci/verified'");
  expect(workflow).toContain("'browser-ui/verified'");
  expect(workflow).toContain("'database-rls/verified'");
  expect(workflow).toContain("'security-integration/verified'");
  expect(workflow).toContain("'ai-privacy/verified'");
  expect(workflow).toContain("'futures-public-network-smoke/verified'");

  expect(workflow).toContain('environment: staging');
  expect(workflow).toContain('STAGING_SSH_KNOWN_HOSTS: ${{ secrets.STAGING_SSH_KNOWN_HOSTS }}');
  expect(workflow).toContain('StrictHostKeyChecking=yes');
  expect(workflow).not.toContain('ssh-keyscan');

  expect(workflow).toContain("'http://127.0.0.1:18090/api/research/overview'");
  expect(workflow).toContain('for sample in 1 2 3 4 5');
  expect(workflow).toContain('--connect-timeout 2 --max-time 12');
  expect(workflow).toContain('proxy_10s_risk');
  expect(workflow).toContain('research_state_unavailable');
  expect(workflow).toContain('v3_status=PRESENT');
  expect(workflow).toContain('v3_status=MISSING');
  expect(workflow).toContain('RESEARCH_STATE_READ_FAILURE_OBSERVED');
  expect(workflow).toContain('RESEARCH_18090_SLOWER_THAN_PROXY_BUDGET');
  expect(workflow).toContain('V3_MISSING_NOT_TRANSPORT_FAILURE');

  expect(workflow).toContain('server_files_written=0');
  expect(workflow).toContain('server_files_deleted=0');
  expect(workflow).toContain('server_processes_restarted=0');
  expect(workflow).toContain('server_processes_stopped=0');
  expect(workflow).toContain('deployment_executed=0');
  expect(workflow).toContain('database_changes=0');
  expect(workflow).toContain('secret_values_collected=0');

  expect(workflow).not.toMatch(/systemctl\s+(restart|stop|start|enable|disable)/i);
  expect(workflow).not.toMatch(/pm2\s+(restart|stop|start|delete)/i);
  expect(workflow).not.toMatch(/(^|\s)sudo(\s|$)/im);
  expect(workflow).not.toMatch(/\bscp\s/i);
  expect(workflow).not.toMatch(/\brsync\s/i);
  expect(workflow).not.toMatch(/curl[^\n]+-X\s+(POST|PUT|PATCH|DELETE)/i);
  expect(workflow).not.toContain('BITGET_SECRET');
  expect(workflow).not.toContain('UPBIT_SECRET');
  expect(workflow).not.toContain('TOSS_CLIENT_SECRET');
});
