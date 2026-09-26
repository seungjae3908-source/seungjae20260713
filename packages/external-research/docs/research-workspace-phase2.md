# Research workspace Phase 2 — stored read path and actual React composition

Existing owner #1042 / Hub #1102. Parent e6b98118b624323b3a0cd49fb9926505c717c372.
This phase is Draft development only. Main conflict remains unresolved.
No source from strategy-research #1350 or canonical Paper workers is changed.

## Application wiring

The existing index already mounts `/research/video/evidence` behind authentication
and basic capability. Its original source reader is copied byte-for-byte to
`video-research-source-evidence.ts` (blob d6423641dd577d55665ce735fc7b44e509c03bfe).
The original path becomes a composition wrapper that mounts `/workspace` first.
The workspace router additionally checks current authentication and
`canManageMembers`, including a second explicit member/token capability check in
the reader. Final app URL: `/api/research/video/evidence/workspace`.
The original three named source-reader exports remain compatible.

The existing ResearchVideoPanel entrypoint keeps source view as default. Its
source implementation is copied to `research-video-source-panel.tsx` unchanged
(blob 2a5701ee1eaf4c7a5014c630cd363ccf48743df2). The wrapper adds a
`전략·백테스트` subtab containing the real React ResearchWorkspacePanel, using
canonical authorizedFetch. No global route or main Research Center page is replaced.

## Trusted read-only storage

Root: `resolve(process.cwd(), 'data', 'research-workspace-v2')`, server-owned only.
No path/SHA/policy is taken from HTTP. Only `policy.json` and a SHA256-named
`registry-<64 lowercase hex>.json` are read. There is NO writer or default policy.
Missing policy/source/registry is visibly unavailable, never fabricated returns.
Policy fields (all required; no extra keys):
- schemaVersion = research-workspace-store-policy-v2
- expectedSourceHeadSha = exact authorized source commit (not necessarily app SHA)
- maxAgeMs = explicit positive freshness limit, at most 31 days
- registrySha256 = SHA256 of exact UTF-8 registry bytes
- scope = ADMIN_RESEARCH_SHARED
- executionAuthority = NONE

Open each request with a pinned policy and immutable registry name/digest.
Directories/files cannot be group/world writable. Symlinks, nonregular files,
oversized input, changes during reads and registry-byte mismatches are rejected.
Read sizes are bounded (8KiB policy, 2MiB registry); errors are redacted.
GET only, no-store and Vary Authorization/Cookie. Request auth and method checks
precede store reads. Hashes are identity checks, not signatures or proof that
source claims, access authorization or numerical producer results are true.
A trusted publisher and reviewed real inputs remain to be supplied separately.

## UI behavior

Stock/crypto and exact-market filters, source-backed rules vs AI assumptions,
version/digest linkage, bounded evidence expansion, recorded model net return and
MDD, missing/permission/error states. No daily return inferred from aggregate.
8-second UI deadline and abort-on-unmount; refresh failure clears previous results.
Scanner/Paper/live application buttons stay disabled. Running status remains
UNVERIFIED; no actual provider/video inference or financial backtest is performed.
Research results initially require admin rights because the disk registry is
admin-shared, NOT private per-user account data. Broader access is separate work.

## Actual validation

Node 22.16.0: 109 tests, including 62 preserved Phase1 tests. Test fixtures are
synthetic and stored only under test/fixtures. Temporary files never touch the
server data root. A native Node HTTP harness exercises the actual stored reader
with synthetic injected authorization; this does NOT validate production auth.
TypeScript 5.8.3 transpilation of new API/React/E2E files passes; no complete
application semantic typecheck is claimed with missing repository dependencies.

React 19.1.1 component with Chromium at 390/768/1024/1440px: filters, empty market,
rule expansion, disabled adoption, permission failure clearing data and unavailable
state pass, zero page errors/external requests/horizontal overflow in this harness.
The harness renders the ACTUAL TSX component but injects the API transport and
uses custom QA CSS, not the app Tailwind build. It is not a live app/production
screenshot. Browser localhost navigation is blocked by environment policy, not
bypassed. Full-app Playwright E2E tests are committed but NOT executed locally.

## Next checkpoint and gates

Resolve #1042's pre-existing current-main conflicts while preserving current UI,
API and other owners' changes. Install repo dependencies in an authorized runner,
run semantic typecheck and the existing/new full app browser suites, and require
fresh exact-head CI. Then bind an approved immutable registry and actual video
access/analysis receipt to the real app. Continuous worker/queue/heartbeat/recovery
and adoption write permissions remain separate stages, not enabled by this read.

No Ready/Merge/rebase/forcepush/main write, deploy, server/DB/Secret/Env mutation,
provider calls/schedule activation/Paper/Telegram/private APIs/orders or Replit.
