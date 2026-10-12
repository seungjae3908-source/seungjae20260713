# Signal V3: four-market original-minute gaps and independent Research evidence

## Four-market source reality
A V3 public scan traverses current *pages*, not complete historical exchange
universes or original 1m archives. A partial KRX roster, missing U.S. bars,
unproved Upbit no-trade periods, or missing Bitget OI/funding histories cannot
be silently treated as a completed scan. The new
\`originalDataRecovery\` snapshot summarizes the twelve actual source receipts
and required next source actions. It performs **zero additional market GETs**
and fabricates **zero OHLCV bars**. Actual historical PIT member inventory,
original native 1m collection and storage remain independently blocked work
in Draft #1534 until provider rights, rosters and archive data are secured.

## Independently signed Research evidence
The optional \`publicResearchProfitBridge\` is OFF by default. Both generated
systemd units and initial dry run explicitly set
\`SIGNAL_INTELLIGENCE_V3_ECONOMIC_BRIDGE_ENABLED=false\`.

With separate owner approval, an independently operated Research evaluator
could place a single mode 0600 immutable signed JSON receipt in an owner-only
0700 directory. It requires its exact research SHA, an Ed25519 *public* key,
root and file name configured in service environment (no secrets are created
by this Draft). The canonical JSON without signature is signed and then
verified with schema \`signal-v3-economic-proof-bundle-v1\`.

The evaluator, **before signing**, must independently inspect authentic
point-in-time membership/delistings, full native original-minute coverage,
decision-time availability, OOS held-out samples, independent walk-forward,
actual fills, all-eight cost components and cost stress, and guard against
selection bias and leakage. A signature of flags/metadata **alone cannot
substitute for those genuine inspections**. The signature establishes who
attested to the proof, not that backtest profitability magically exists.

The adapter matches market/symbol/timeframe/direction/exact source signal ID
plus frozen strategy/version/parameters/research SHA/cost version. Any
missing/expired/malformed/unsigned/source-mismatched record, TRAIN-only
receipt, synthetic/replay/backfill/manual mark, incomplete PIT/OOS/cost
evidence, or unverifiable signature fails closed. Scanner data quality,
risk and standalone economic admission are still mandatory. CI signer
fixtures exercise plumbing only; they do not certify real profitability.

No service activation, data collection, paper admission, market/member
Telegram sends or trading orders in this work. Draft/Drift only,
no Replit, Ready/Merge/Deploy/PM2/systemd/DB/secret changes.

## Additional proof/notification integrity

The verified signed-record reader returns immutable cloned receipts through a
read-only lookup and rejects fabricated `SIGNED_EVIDENCE_AVAILABLE` caller
objects. Four-market diagnostic pages must share one exact source cycle UUID;
otherwise no mixed-epoch source readiness can be claimed.

The Telegram public-room worker durably records an unconfirmed send reservation
**before** making a Bot API request, and syncs the ledger's parent directory
after rename. A restart or network-ambiguous outcome leaves a no-replay marker
for operator reconciliation. Explicit zero-attempt `NOT_CONFIGURED` and
`COOLDOWN` outcomes alone may release it for safe retry. Confirmed legacy
delivery suppresses only its original source UTC day; an independently observed
later day can be alerted again. Unknown legacy outcomes remain conservative.

This guards process-crash replay with a single active subscriber. It is **not**
a guarantee of true global exactly-once delivery across multiple unsynchronized
workers, provider acknowledgments or external database failover. The protected
Production recipient receipts and owner-approved operational tests remain
unverified.
