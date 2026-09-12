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
  expect(controlSource).toContain('NOT_CONNECTED');
  expect(controlSource).toContain('Authority');
  expect(controlSource).toContain('NONE');
  expect(controlSource).toContain('Ready / Merge 승인');
  expect(controlSource).toContain('Staging 승인');
  expect(controlSource.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  expect(controlSource).not.toContain('fetch(');
  expect(controlSource).not.toContain('axios');
});
