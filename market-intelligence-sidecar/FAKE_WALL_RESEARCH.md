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
