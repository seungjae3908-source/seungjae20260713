# Exact-main Application CI coverage

Staging dispatch requires the exact current `main` SHA to have six successful verification statuses and a successful `Application CI` run.

The primary Application CI workflow intentionally uses path filters for expensive validation. The companion `application-ci-main-coverage.yml` workflow runs on every `main` push:

- it reuses an already-started official Application CI run when one exists;
- it dispatches the official workflow only when path filtering left the exact SHA uncovered;
- it waits for all six required statuses;
- it rejects stale `main` SHAs;
- it never dispatches staging or production and reads no secrets.

The regression contract runs from `pnpm --dir api-server run test:phase12`.
