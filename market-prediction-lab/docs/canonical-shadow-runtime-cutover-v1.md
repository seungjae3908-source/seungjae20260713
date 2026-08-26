# Canonical Shadow runtime cutover preparation v1

Status: Draft preparation only. `cutoverEnabled=false`, `scheduleActivated=false`.

## Future minimum wiring

1. Resolve one exact immutable canonical research SHA.
2. Select a successful, unexpired Producer artifact only after Strategy Identity, Model Identity, TRAIN, VALIDATION, and digest validation.
3. Select a successful canonical predecessor only from the same Producer and Strategy/Model lineage, with compatible research ancestry and valid schema/digests.
4. Carry pending settlements forward. Fetch public future candles only after settlement is due; never reconstruct or backfill.
5. Run Rule-only, Model-only, frozen 65/35, PSI, KS, JSD, and the frozen Drift policy without tuning.
6. Serialize all writers under `prediction-lab-canonical-shadow-writer-v1` with `cancel-in-progress=false`.
7. Validate the complete artifact, then atomically publish only to `RESEARCH_STATE_ROOT/forward/shadow-state.json`. Invalid, stale, tampered, replayed, duplicate, partial, or mismatched artifacts never replace last-good state.
8. Let the existing #659 adapter consume the canonical state root; do not create a second state root or copy JSON manually.

## Equivalence gate

The same public-data fixture must match on market, symbol, timeframe, input timestamp, feature schema, model identity, Rule probability, Model probability, frozen Blend probability, final direction, reference price, and observation identity inputs. Additional canonical provenance fields are allowed; semantic differences are not.

## Rollback

On a future approved cutover failure:

1. Stop the canonical writer.
2. Preserve the last-good canonical state without reset or synthetic continuity.
3. Restore the legacy runtime path only through a separate explicit approval.

No rollback or cutover action is authorized by this document.
