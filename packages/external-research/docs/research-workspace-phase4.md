# Phase 4 — reviewed immutable registry publication (Draft, not activated)

Owner #1042 / Hub #1102. Parent ac2bed0cc111d115364b5f0064a2cf9f66768a4c.
The existing read model, read-only store, API and React component are reused.
No provider, compiler, backtester, scheduler, paid API or trading client is added.

## What is implemented

`prepareWorkspacePublication` first runs the existing source/rule/result checks,
then requires bounded archived bytes for every content input, content output and
linked result. It verifies SHA256 of the actual bytes and joins the content receipt
and result projection to the registry. Shared digests are read once. Unknown data
classification, unavailable archives, wrong bytes, altered metrics, missing rules,
stale source and unknown strategies fail closed. Archive calls time out after 3s.
The archive reader must respect its AbortSignal; a timeout cannot cancel arbitrary
side effects in a non-cooperating callback. No input URL is dereferenced.

Content output envelope: schemaVersion=research-workspace-content-artifact-v1,
sourceId, receiptId, accessLevel, provider, model, completedAt, inputDigest and
segments (source segment fields except the self-referential contentDigest).
Result envelope: schemaVersion=research-workspace-result-artifact-v1 and run
(the exact producer projection except resultDigest and summaryDigest).
These are narrow integration envelopes, not claims of a provider-native format.
A future authorized producer must map actual archived observations into them.
Dataset/code digests remain declared lineage; this module does NOT rerun the
financial engine, verify every dataset byte or assess semantic truth of AI rules.

Preparation is read-only. It returns a frozen review descriptor, source/registry/
policy hashes, byte-evidence references and counts. Internal bytes are private to
the prepared plan; later mutation of the caller input cannot change them. A copied
or forged descriptor is not a valid publish capability. To retry in another process,
repeat preparation with the same frozen review inputs, then obtain authorization.

`createWorkspaceRegistryPublisher` is a trusted server-side library, NOT an HTTP
write route. It requires an explicit externally supplied authorizePublication
callback, reviewed plan, exact root and expected previous policy digest (null only
for a new store). The callback must check current canonical admin authority, scope,
expiry/revocation and exact plan/root/previous-version bindings. No approval record
is generated here. Permission is rechecked before switching the visible policy.

Default mode REVIEWED_RUNTIME refuses SYNTHETIC archive classification. OFFLINE_TEST
and test fault hooks are only for isolated test directories. Classification is a
trusted archive input, NOT something inferred from title or minted by an LLM.
Test callbacks stand in for authorization/classification; they are not live proof.
Hashes establish integrity, not creator truth, consent, profitability or OOS.

## Disk protocol and recovery

Linux local filesystem only. Existing absolute canonical owner-controlled root;
no directory auto-creation, symlink root or group/world-writable destination.
Fixed SHA-addressed registry and publication receipt filenames. O_EXCL writer lock;
NOFOLLOW/NONBLOCK bounded reads reject symlinks, FIFO/device files, hardlinks,
unsafe ownership/mode, oversize and in-read changes. Trusted same-UID cooperative
writers and secure parent directories are assumptions; not an adversarial same-UID
sandbox or a distributed/NFS lock. No distributed exactly-once claim.

1. Confirm source still equals the reviewed source and remains fresh.
2. Obtain exclusive writer lock and compare the previous policy digest.
3. Stage and fsync complete immutable registry/receipt; link without overwrite.
4. Recheck prior version, freshness and authorization.
5. Atomically rename the fsynced policy on the same filesystem; sync directory.
6. Read back using the existing store and verify exact identity.

Old registry files remain for readers that pinned the old policy. Failed validation
never changes the active pointer. A pre-switch interruption leaves the previous
result readable (unreferenced staged immutable files may remain). A post-switch
exception returns PUBLICATION_COMMIT_UNCERTAIN_READBACK_REQUIRED rather than falsely
claiming rollback. Retrying the same reviewed publication returns ALREADY_PUBLISHED
only when receipt, current policy and registry agree. Receipts say PREPARED and must
be interpreted with current policy; receipt existence alone is not commit proof.

Actual process termination leaves .publish.lock in place. This implementation never
steals a lock by elapsed time. Recovery must confirm the owner is dead, inspect
policy/receipt and explicitly authorize lock cleanup. Automatic worker recovery,
audit indexing and orphan artifact garbage collection are later work. The tests
perform explicit test-operator cleanup after confirming SIGKILL. No runtime lock
or user/server file is modified in this development session.

## Verification / boundaries

Run `node --test packages/external-research/test/research-workspace*.test.js`.
New cases include exact artifact joins, no-default approval, synthetic runtime
rejection, immutable plans, source expiry, stale writer/CAS conflicts, idempotency,
reader continuity during version changes, FIFO/symlink/hardlink rejection,
permission revocation, concurrent writers, before/after commit failure and actual
child-process SIGKILL before/after the policy switch. Published negative results
are read through a real local HTTP handler and the existing browser schema parser.
Authentication in this harness is deliberately injected; not production auth.
Existing UI/browser tests are separate; no new financial or real-video result.

Reference: https://nodejs.org/download/release/latest-jod/docs/api/fs.html
Native exclusive open, fsync, link and rename are used rather than concurrent
writeFile calls to a shared results file. Crash tests are not hardware-power-loss
or filesystem-corruption certification.

No caller is wired to publish on the operational server. No runtime policy, default
success data, public video inference or server timer is created. Existing deployment
and explicit real publication/24h activation approvals remain separate. Inspection
is not strategy adoption: no scanner, Paper, live execution or canonical credit.

Next: bind the canonical authorization/archive producer and real allowed content
receipt, review exact publication plan, test real-data end-to-end, then stage the
bounded durable worker/queue. Keep missing actual evidence visible rather than
publishing synthetic fixtures. No Ready/Merge/main rewrite/deploy/provider call,
operational DB/Secret/Env mutation, Paper/Telegram/private API/orders or Replit.
