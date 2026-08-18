# Fake Wall / Spoof Candidate Research Boundary

This lane extends the existing Market Intelligence Sidecar. It does not create a separate scanner or trading engine.

## Current behavior

The existing sidecar already detects large-wall liquidity withdrawal from public order-book and trade evidence. That signal remains unchanged in this first phase.

## New evidence observer

`market-intelligence-spoof-candidate/v1` is an **OBSERVE_ONLY** evidence contract. It distinguishes a raw wall withdrawal from a stronger fake-wall/spoof candidate by tracking bounded multi-snapshot evidence:

- wall persistence across snapshots
- wall relative size
- distance to mid
- withdrawal/cancellation ratio
- executed ratio
- nearby quote migration
- spread shock
- snapshot chronology/gaps
- post-withdraw mid response
- OFI/CVD/microprice flow confirmation

False-positive confounders and missing evidence produce `INSUFFICIENT_EVIDENCE`, not a confirmed spoof label.

## Safety

- `scannerHardBlockAllowed=false`
- `parentGateImpact=NONE`
- `orderAllowed=false`
- `executionAuthority=NONE`
- no private API
- no real order/cancel/amend/transfer/withdrawal
- no threshold/class-weight/label/blend retuning from forward outcomes

The observer must be evaluated on OOS/cost-stress/regime evidence and later clean future-only Paper/Shadow evidence before any proposal to alter Scanner ranking, Profit gates, or trading eligibility.

## Forward evidence ledger (P0-C1)

The runtime eight-snapshot `Map` remains deliberately bounded and in-memory for live observation. It is **not** treated as durable research evidence. `market-intelligence-fake-wall-forward-ledger/v1` adds an artifact-only, public-data-only immutable ledger contract so a process restart cannot silently erase an already-observed hypothesis.

The ledger carries deterministic candidate identity, exact producer/research SHA, detection time, evidence fingerprint, provenance/freshness, confounders, fixed horizon policy, and predecessor/successor artifact lineage. The predeclared `fake-wall-forward-horizons/v1` policy uses fixed 5m, 15m, and 60m horizons. Those horizons are part of the observation contract and must not be changed after an outcome is seen.

A candidate remains `PENDING` until its horizon matures. If an allowed future public reference mark is not available inside the immutable settlement window, that horizon becomes `INVALIDATED` with `HORIZON_MARK_MISSING`; it is never backfilled as zero, a win/loss, PF, or profit. Observed future marks may record reference return/direction and, when public path marks exist, MFE/MAE. Missing cost or execution evidence keeps profit/win-rate claims `N/A` / `INSUFFICIENT_DATA`.

Restart continuity uses predecessor `state.json` + `summary.json` + `manifest.json`, SHA-256 digests, exact research SHA, and an artifact content digest. A digest/identity/safety mismatch fails closed as `ARTIFACT_CHAIN_BROKEN`; lineage is never silently stitched together. Duplicate `candidateId` observations are idempotent, while the same ID with changed immutable content is rejected.

`run-fake-wall-forward-ledger.mjs` is a deterministic CLI harness only. It is **not a scheduler**. Natural settlement must be wired through the existing #461 owner/cadence or an existing Forward Observer artifact-chain owner; no new Scanner, observer service, or schedule is authorized by this contract.

The ledger has `scannerRankingImpact=NONE`, `tradingEligibilityImpact=NONE`, `executionAuthority=NONE`, and `profitabilityClaimAllowed=false`. It must not alter Scanner ranking, Profit gates, eligibility, orders, private APIs, DB state, server configuration, or Production.

### Current limitation

The immutable/restartable ledger primitive and deterministic harness can be validated independently, but **natural artifact producer/upload wiring and a real successor artifact are still required before P0-C1 is complete**. Until then, the fake-wall candidate remains research-only and cannot be promoted from forward outcomes.
