# Missing-Evidence UI Contract

Read-only display contract for the approved P1 evidence UX work.

## States

| State | User-visible meaning | Must never render as |
|---|---|---|
| `VALUE` | observed/known value, including numeric `0` | missing evidence |
| `N_A` | metric does not apply to this market/context | `0` |
| `NOT_COLLECTED` | evidence has not been collected yet | `0` |
| `STALE` | evidence exists but is too old for the current decision | fresh value / `0` |
| `UNAVAILABLE` | provider/runtime cannot provide a valid value | `0` |
| `PERMISSION_REQUIRED` | the current user is not authorized to see the evidence | `0` |

## Fail-closed rules

- `0` is preserved only when it is an actual finite numeric value.
- `null`, `undefined`, non-finite numbers, and empty strings are never coerced to zero.
- stale/unavailable/permission states take precedence over a present value so stale evidence is not presented as current.
- formatters run only for `VALUE` states.
- this contract has no trading, provider, database, rerun, or tuning authority.

## Surface integration ownership

The contract is intentionally isolated before wiring into shared UI surfaces. Fresh ownership audit found an active Account read-only owner (#428), so Account UI files are `DO_NOT_DUPLICATE` until that owner is reconciled. Scanner, AI Chart, and Portfolio wiring must also re-check current-main ownership immediately before edits.

This phase is not complete until Scanner / AI Chart / Portfolio / Account show these states consistently on current main and Desktop/Mobile browser regression is exact-head green.
