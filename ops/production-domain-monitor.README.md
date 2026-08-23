# Production domain monitor

Canonical endpoint roles:

- Primary user-facing endpoint: `https://lsj119.ddnsfree.com`
- Manual fallback endpoint: `https://lsj119.duckdns.org`
- Expected Production IPv4: `158.247.235.32`

The two free DDNS hostnames do **not** provide automatic DNS failover between each other. If the primary hostname itself cannot resolve, clients cannot be redirected by the application because no request reaches Caddy. The fallback is therefore an independently reachable emergency address.

`.github/workflows/production-domain-health-monitor.yml` runs read-only checks every hour and on manual dispatch. It validates:

1. System DNS resolution.
2. Cloudflare `1.1.1.1` A-record resolution.
3. Google `8.8.8.8` A-record resolution.
4. Expected Production IPv4 presence.
5. HTTPS/TLS reachability.
6. `/api/health` response and deployment identity.
7. `deploySha`, `processDeploySha`, and `deployMarkerSha` internal parity.
8. Primary/fallback `deploySha` equality.

Any missing or inconsistent evidence fails closed. The monitor performs GET/read-only operations only and has no Production, database, server, Caddy, private-provider, or trading mutation authority.

## Rollout boundary

The live Caddy endpoint already accepts both hostnames. This repository contract designates Dynu as the primary address for new monitoring and user-facing navigation. Existing protected Production QA/release workflows are intentionally not bulk-rewritten in this change: active incident owners must migrate their own hard-coded Production base URL without overlapping this isolated monitor owner. Until those owner-controlled workflows are updated, their DuckDNS checks remain valid fallback-path evidence rather than proof that DuckDNS is still the preferred user-facing endpoint.
