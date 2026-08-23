# Production domain monitor

Canonical endpoint roles:

- Primary user-facing endpoint: `https://lsj119.ddnsfree.com`
- Manual fallback endpoint: `https://lsj119.duckdns.org`
- Expected Production IPv4: `158.247.235.32`

The two free DDNS hostnames do **not** provide automatic DNS failover between each other. If the primary hostname itself cannot resolve, clients cannot be redirected by the application because no request reaches Caddy. The fallback is therefore an independently reachable emergency address.

`.github/workflows/production-domain-health-monitor.yml` runs read-only checks every hour at minute 17 and on manual dispatch. It validates:

1. System DNS resolution.
2. Cloudflare `1.1.1.1` A-record resolution.
3. Google `8.8.8.8` A-record resolution.
4. Expected Production IPv4 presence.
5. HTTPS/TLS reachability.
6. `/api/health` response and deployment identity.
7. `deploySha`, `processDeploySha`, and `deployMarkerSha` internal parity.
8. Primary/fallback `deploySha` equality.

Any missing or inconsistent evidence fails closed. The monitor performs GET/read-only operations only and has no Production, database, server, Caddy, private-provider, or trading mutation authority.

Validation on PR #648:

- Production Domain Health Monitor Run `32624609425`: SUCCESS.
- Production Browser Smoke static safety Run `32624609483`: SUCCESS.
- Application CI Run `32624609381`: SUCCESS, Required CI 6/6.

The scheduled hourly monitor becomes active from the default branch only after this Draft PR is separately approved and merged. Until then the live Dynu endpoint itself is already available through the server-side Caddy configuration, while the GitHub schedule remains unactivated.