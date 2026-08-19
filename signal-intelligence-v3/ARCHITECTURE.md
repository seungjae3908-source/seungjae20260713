# Architecture

## Independent release model

`Signal Intelligence V3` is a fast-release public-data service. The app and Telegram consume the same immutable snapshot. The private-account Execution Gateway is a separate slow-release component and is not part of this service.

```text
Public/Canonical Scanner Evidence
        ↓
Signal Intelligence V3
        ├─ KR BUY
        ├─ US BUY
        ├─ Spot BUY
        ├─ Futures LONG
        └─ Futures SHORT
        ↓
AI committee (rescan/veto only)
        ↓
Risk + conservative leverage
        ↓
Immutable snapshot/events
        ├─ App reader
        └─ Existing Telegram transport

================ privilege boundary ================

Private Execution Gateway (not included)
```

## One-time release bridge

GitHub only dispatches a new workflow when that workflow exists on the default branch. Therefore the intended rollout is:

1. merge the small release/validation bridge once;
2. thereafter accept an immutable Signal Intelligence service SHA that may live on its dedicated service branch;
3. verify the dedicated exact-SHA Signal Intelligence validation artifact;
4. deploy only `signal-intelligence-v3/**` to its own release directory/process;
5. never require the app Production SHA to move for ordinary Signal Intelligence service updates.

This removes repeated app-main merge/deploy coupling while keeping immutable provenance.

## Execution boundary

The independent service may never access or mutate:
- brokerage/exchange credentials;
- account balances or positions;
- order/cancel/amend endpoints;
- transfers or withdrawals;
- app Production database financial state.

Future automatic trading must consume a signed/versioned Trade Plan through a separately reviewed Execution Gateway. AI output alone can never become an order.
