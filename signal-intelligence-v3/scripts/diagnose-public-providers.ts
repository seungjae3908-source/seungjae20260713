// @ts-nocheck
import {
  PUBLIC_PROVIDER_ENDPOINTS,
  probePublicProvider,
} from '../src/public-provider-diagnostics.mjs';

const rows = [];
for (const endpoint of PUBLIC_PROVIDER_ENDPOINTS) rows.push(await probePublicProvider(endpoint));

console.log(JSON.stringify({
  schemaVersion: 'public-provider-connectivity-diagnostic-v1',
  generatedAt: new Date().toISOString(),
  publicOnly: true,
  proxyConfigured: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY),
  exactHosts: [...new Set(PUBLIC_PROVIDER_ENDPOINTS.map((row) => new URL(row.url).hostname))],
  rows,
  safety: { authenticatedAccountApiUsed: false, credentialsRead: false, orderSubmitted: false },
}, null, 2));
