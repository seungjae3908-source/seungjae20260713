# Research target CI provenance: source-only Draft

## What is actually included
This Draft adds a read-only GitHub metadata helper, its unit tests and a
pull-request-only test workflow. **It is not wired into Research activation.**
The existing activation workflow, server transports and maintenance script
remain byte-identical to the base revision. This Draft cannot remove the
existing activation block or activate any server by itself.

The tool safety check rejected two separate source writes: the proposed
operating-diagnostic module and the proposed integration into the existing
activation workflow. Neither is included, retried through another route or
embedded as a patch. Only the permitted independent metadata helper is retained.
No operating-diagnostic success or activation integration is claimed.

## Helper behavior
`EXACT_CURRENT_MAIN_SIX` verifies the latest direct-main Application CI and
six latest coherent required statuses on the exact target. A failed, pending,
cancelled or inconsistent newer main run remains a blocker; it never falls
back to an older successful proof.

`CANONICAL_PREMERGE_SIX_AND_IDENTICAL_MERGED_TREE` is considered only when
there is no direct-main CI or orphan required status on the target. It calls
the existing unchanged canonical authorizer, which checks actual merged PR
identity, tested-head Required6 on one run, exact file-tree equality,
post-merge proof, CI completion before merge, newer head runs, owner/current-main
context and concurrent mutations. All API methods are read-only.

Main, direct-run inventory and relevant statuses are re-read before returning.
`assertSameCodeProof` can compare every identity field of two validated
proofs. It is a library function, not an installed after-approval gate.
No commit status, workflow dispatch, environment approval, host call, setting
change, account operation or order is performed by the helper or the new QA.

## Verification boundary
Unit tests exercise the real existing canonical resolver using mocked GitHub
metadata. They test direct-main/canonical success; failed, pending, mixed,
forged and stale proof rejection; main movement; conflicts; API failures; and
proof identity comparison. They are not live GitHub authorization, actual
provider, server deployment, Staging, OOS or Paper-settlement tests.
The proposed workflow-integration tests were not included because integration
was denied; no existing repository test or release guard was removed.

## Unresolved operational work
The actual protected audit38355059131 attempt2 observed53 checks at research
SHA5670a98b:32 PASS,1 BLOCKED,10 PENDING,9 MISSING,1 UNKNOWN. The prerequisite
blocker was active Research dependents. Nine missing input bindings covered
app bundle storage, six policy/evidence/runtime/cost settings and KR/US inputs.
This older audit cannot certify a newer main. There was no new host audit here.
Existing maintenance, real inputs, provider responses, exact-version cycles,
independent OOS/full costs/Paper settlement and shared Staging remain unresolved.
No empty files, invented market data, fake statuses or guard bypass are allowed.

Replit/Replit Agent prohibited. Hub1102 records both the limited source work
and the rejected integration. No further activation approval is requested.
