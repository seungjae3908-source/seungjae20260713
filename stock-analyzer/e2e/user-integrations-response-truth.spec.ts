import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const lifecyclePath = fileURLToPath(new URL('../src/lib/user-integrations-request-lifecycle.ts', import.meta.url));
const responsePath = fileURLToPath(new URL('../src/lib/user-integrations-response.ts', import.meta.url));
const panelPath = fileURLToPath(new URL('../src/components/user-broker-telegram-panel.tsx', import.meta.url));
const backendPath = fileURLToPath(new URL('../../api-server/src/routes/user-broker-telegram.ts', import.meta.url));

test('user integrations validates canonical HTTP 200 truth before the UI can normalize safe-looking defaults', async () => {
  const [lifecycle, response, panel, backend] = await Promise.all([
    readFile(lifecyclePath, 'utf8'),
    readFile(responsePath, 'utf8'),
    readFile(panelPath, 'utf8'),
    readFile(backendPath, 'utf8'),
  ]);

  expect(panel).toContain("setState(normalizeIntegrationState(result.value));");
  expect(panel).toContain("{state.telegram.connected ? '연결됨' : '연결 안 됨'}");

  expect(lifecycle).toContain("import { requireUserIntegrationsResponse } from '@/lib/user-integrations-response';");
  const validationIndex = lifecycle.indexOf('.then((value) => this.validate ? this.validate(value, identity) : value);');
  const transportSuccessIndex = lifecycle.indexOf(
    "(value): UserIntegrationsTerminal<T> => ({ status: 'success', identity, requestKey, generation, value })",
    validationIndex,
  );
  expect(validationIndex).toBeGreaterThanOrEqual(0);
  expect(transportSuccessIndex).toBeGreaterThan(validationIndex);
  expect(lifecycle).toContain('(value, identity) => requireUserIntegrationsResponse(value, identity),');

  expect(response).toContain("root.ok !== true");
  expect(response).toContain("telegram.status !== 'ACTIVE' || telegram.connectedAt === null");
  expect(response).toContain("policy.userId !== expectedUserId");
  expect(response).toContain("root.privateApiRequests !== 0");
  expect(response).toContain('const expectedLinkingReady = runtime.deliveryReady === true');
  expect(response).toContain('runtime.linkingReady !== expectedLinkingReady');
  expect(response).toContain("runtime.orderAuthority !== 'NONE'");
  expect(response).toContain('root.partial !== expectedPartial');

  expect(backend).toContain('ok: true,');
  expect(backend).toContain('telegramRuntime: telegramRuntimeState(),');
  expect(backend).toContain('linkingReady: deliveryReady && webhookConfigured && botUsernameConfigured,');
  expect(backend).toContain("prioritySemantics: 'DELIVERY_URGENCY_ONLY'");
  expect(backend).toContain('privateApiRequests: 0,');
  expect(backend).toContain('ordersSubmitted: 0,');
  expect(backend).toContain('ordersCancelled: 0,');
});