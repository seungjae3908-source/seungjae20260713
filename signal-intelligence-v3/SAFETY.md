# Safety invariants

Signal Intelligence V3 is recommendation-only.

- `executionAuthority = NONE`
- `privateTradingApiAllowed = false`
- `realOrderAllowed = false`
- AI promotion authority = false
- AI leverage authority = false
- no account, balance, position, order, cancel, amend, transfer, or withdrawal API
- no app Production DB mutation
- no forced TOP-N fill
- data failure is not converted into valid NO_TRADE
- futures LONG and SHORT ambiguity resolves to ABSTAIN, not forced direction
- leverage requires verified tier/liquidation-distance evidence and remains INDICATIVE_ONLY
