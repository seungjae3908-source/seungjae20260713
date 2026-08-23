import { createHash } from 'node:crypto';

export type PrivateProvider = 'toss' | 'upbit' | 'bitget';
export type PrivateProviderResource =
  | 'credential'
  | 'account'
  | 'holdings'
  | 'positions'
  | 'order'
  | 'reconciliation'
  | 'private-stream'
  | 'telegram';

export type PrivateProviderScopeInput = {
  userId: string;
  provider: PrivateProvider;
  resource: PrivateProviderResource;
  accountRef?: string | null;
  resourceId?: string | null;
};

const ACCOUNT_BOUND_RESOURCES = new Set<PrivateProviderResource>([
  'holdings',
  'positions',
  'order',
  'reconciliation',
  'private-stream',
]);

function normalizeRequired(label: string, value: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}_REQUIRED`);
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label}_INVALID`);
  }
  return normalized;
}

function normalizeOptional(label: string, value: string | null | undefined, maxLength: number) {
  if (value == null) return null;
  return normalizeRequired(label, value, maxLength);
}

export function buildPrivateProviderScopeKey(input: PrivateProviderScopeInput) {
  const userId = normalizeRequired('PRIVATE_USER_ID', input.userId, 256);
  const accountRef = normalizeOptional('PRIVATE_ACCOUNT_REF', input.accountRef, 512);
  const resourceId = normalizeOptional('PRIVATE_RESOURCE_ID', input.resourceId, 1024);

  if (ACCOUNT_BOUND_RESOURCES.has(input.resource) && !accountRef) {
    throw new Error('PRIVATE_ACCOUNT_REF_REQUIRED');
  }

  const canonical = JSON.stringify({
    version: 1,
    userId,
    provider: input.provider,
    accountRef,
    resource: input.resource,
    resourceId,
  });
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');

  // The external key contains only non-secret category labels and a digest. Raw
  // user/account/order identifiers are deliberately not exposed in cache keys,
  // logs, worker leases, or reconciliation lock names.
  return `private-scope:v1:${input.provider}:${input.resource}:${digest}`;
}

export function buildPrivateExecutionLeaseKey(input: {
  userId: string;
  provider: PrivateProvider;
  accountRef: string;
  clientOrderId: string;
}) {
  return buildPrivateProviderScopeKey({
    userId: input.userId,
    provider: input.provider,
    accountRef: input.accountRef,
    resource: 'reconciliation',
    resourceId: `client-order:${normalizeRequired('PRIVATE_CLIENT_ORDER_ID', input.clientOrderId, 1024)}`,
  });
}
