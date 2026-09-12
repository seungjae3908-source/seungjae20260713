import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const controlSource = readFileSync(resolve(process.cwd(), 'src/pages/agent-hub-control.tsx'), 'utf8');

test('Agent Hub V5 admin control route stays capability-gated and fail-closed', () => {
  expect(appSource).toContain("const AgentHubControlPage = lazy(() => import('@/pages/agent-hub-control'))");
  expect(appSource).toContain("function AgentHubControlAccess() { return gated('canManageMembers', <AgentHubControlPage />); }");
  expect(appSource.match(/path=\"\/admin\/agent-hub\"/g)).toHaveLength(1);
  expect(appSource).toContain('<Route path="/admin/agent-hub" component={AgentHubControlAccess} />');

  expect(controlSource).toContain('Execution');
  for (const state of [
    'NOT_CONFIGURED',
    'CONFIGURED',
    'QUEUED_FOR_COORDINATOR',
    'NORMALIZED_FOR_COORDINATOR',
    'READY_FOR_EXECUTOR',
    'IN_PROGRESS',
    'WAITING_APPROVAL',
    'NEEDS_CONTEXT',
    'BLOCKED',
    'COMPLETED',
    'FAILED_CLOSED',
  ]) expect(controlSource).toContain(state);
  expect(controlSource).toContain('Authority');
  expect(controlSource).toContain('NONE');
  expect(controlSource).toContain('Ready / Merge 승인');
  expect(controlSource).toContain('Staging 승인');
  expect(controlSource.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(3);

  expect(controlSource).toContain("fetch(`/api/admin/agent-hub${path}`");
  expect(controlSource).toContain("authorization: `Bearer ${token}`");
  expect(controlSource).toContain("bridgeRequest('/status', token)");
  expect(controlSource).toContain("bridgeRequest('/commands', token");
  expect(controlSource).toContain('bridgeRequest(`/commands/${commentId}/status`, token)');
  expect(controlSource).toContain('setTimeout(() => void refresh(), 15_000)');
  expect(controlSource).toContain('Latest evidence #');
  expect(controlSource).not.toContain('api.github.com');
  expect(controlSource).not.toContain('AGENT_HUB_GITHUB_TOKEN');
  expect(controlSource).not.toContain('/orders');
  expect(controlSource).not.toContain('/deploy');
  expect(controlSource).not.toContain('axios');
});
