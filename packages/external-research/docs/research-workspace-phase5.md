# Phase5 — reviewed archive and current administrator binding (Draft only)

Owner #1042 / Hub #1102. Base be4efb7fdc9d70ebbf44b365f6a8b2d16b714d19.
This connects real filesystem reads and the existing canonical authentication
middleware to Phase4. It does not create video evidence, approval grants, an
HTTP publication route, a database, a provider caller, or a server worker.

## Data flow and exact responsibilities

A reviewed archive contains `manifest-<sha256>.json` and
`artifact-<sha256>.bin`. A trusted caller supplies its root and reviewed manifest
SHA. `openReviewedWorkspaceArchive` checks the manifest and bounded local bytes;
`prepareWorkspaceFromReviewedArchive` delegates to the original Phase4 publisher
validator and returns its unchanged private prepared plan plus archive lineage.
Content input/output/result roles are separately allowlisted; unknown files or
conflicting classifications for identical bytes are rejected. Classification is
trusted producer/reviewer metadata, NOT a result of parsing claims inside an AI
response. OBSERVED does not prove consent, semantic correctness, PnL or OOS.

Manifest fields are exact: schemaVersion=research-workspace-archive-v5,
createdAt, producerCodeSha, reviewId, artifacts. Each artifact has kind
(CONTENT_INPUT/CONTENT_OUTPUT/RESULT), digest, byteLength, dataClass
(OBSERVED/SYNTHETIC). Maximum256references,128KiBmanifest,2MiBperfile,32MiBsum.

File paths are server-selected fixed basenames. Linux local private roots,
no symlink/FIFO/hardlink inputs, bounded reads, file/root identity checks and
abort signals protect preparation. Secure parent directories and cooperative
same-UID processes remain assumptions. This is not a hostile same-UID sandbox,
NFS locking scheme or interruptible arbitrary kernel-I/O guarantee.

## Publication approval and identity

`createWorkspaceApprovalFileReader` reads a fresh, private
`approval-<opaque-id>.json` each time. There is deliberately no approval writer.
A separately authorized admin/operator workflow must issue or revoke these files.
`createWorkspaceApprovalVerifier` binds actor, root, mode, plan digest, policy
digest, exact prior policy and time window. Maximum grant lifetime is one hour.
It reads the grant, resolves the current principal, then reads the grant again.
Revocation/mutation while authentication is in flight rejects the operation.
Both the initial and pre-switch Phase4 checks repeat this flow. Exceptions,
identity mismatches, unknown roles and deadlines fail closed. No browser role or
approval object is authoritative; only an opaque ID is accepted.

`createCurrentWorkspaceAdminResolver` invokes the existing `requireAuthenticated`
and `requireAdmin` with a NEW request object on each check, intentionally avoiding
auth.ts's existing cached req.member/accessToken shortcut. Thus canonical getUser
verification and user-scoped current profiles lookup are reused. Tokens stay in
the caller closure and never enter returned principals, manifests or logs.
`createCanonicalWorkspacePublicationAuthorizer` composes the real filesystem
approval reader and canonical resolver. No modifications to global auth or member
permissions are made. Instantiate per session; never share a user's resolver as
an application-wide singleton.

A three-second verification deadline stops waiting and denies permission. It
cannot force cancellation of the existing auth client's already-issued network
read; its late result cannot authorize publication. Role/grant revocation after
the FINAL check but before rename is not transactionally eliminated. This is a
bounded pre-switch check, not a global atomic authorization transaction.

## Verification boundaries

Local Node tests exercise actual temp-directory files and the complete
archive→Phase4plan→exact approval→atomic publication→existing stored reader→UI
parser chain, including negative synthetic returns. Only OFFLINE_TEST mode is
used for successful publication in these tests. Runtime's existing rejection of
synthetic data remains in Phase4 and is rerun unchanged.
New TypeScript tests execute the ACTUAL canonical auth and capability code,
with Supabase Auth/profile transports injected as test doubles. They cover
approved/pending/revoked/inactive/downgraded profiles, subject mismatch, errors,
repeat remote resolution, token redaction and expired approval. No Supabase
project or real account is contacted or modified by these tests.
The dedicated CI retains the existing typechecks,9HTTPtests and12actual-app
React/Tailwind fixture browser tests and adds the canonical-auth suite using
already-pinned esbuild. It does not change dependencies or hide failures.

## How to use without publishing

Import prepareWorkspaceFromReviewedArchive and pass archiveRoot,
manifestSha256, videoEvidence (existing sanitized snapshot), registry, policy
(existing trusted source SHA/freshness/time), and optional AbortSignal.
The returned plan is the original Phase4 plan, ready for explicit review.
Do not store a fake OBSERVED envelope or synthetic approval in any runtime root.
To publish later, use the existing createWorkspaceRegistryPublisher with
createCanonicalWorkspacePublicationAuthorizer and a separately approved grant ID.
This document is not that approval, nor a request to perform the publication.

## Precise next checkpoint

Actual allowed content bytes, provider/model response and economic result
producer must populate these narrow envelopes from existing canonical sources;
the current PR records do not supply a verified real video-analysis/result pair.
No video inference or financial result is fabricated here. Next work should bind
ONE actually authorized input end-to-end, not build another duplicate engine.
Then, and only under separate runtime authority, publish and verify with an actual
admin session. 24hqueue/heartbeat/recovery,adoption and deployment remain separate.

Latest observed main d074c880 was not merged into this branch; earlier comparison
showed no owner-path overlap. Refresh the exact base before release. No Ready,
PRmerge,mainwrites,deploy,operational DB/Secret/Env writes,provider invocation,
Paper/scheduleactivation,Telegram,private trading APIs,orders or Replit.

## Primary documentation checked

- https://supabase.com/docs/reference/javascript/auth-getuser : authentic user
  lookup is a server request; current database permissions remain a separate check.
- https://nodejs.org/api/fs.html : Linux no-follow/nonblocking flags and file types.
- Supabase changelog.md retrieval was unsupported by web parser; HTML changelog
  was used. No Supabase library/API upgrade or token validation replacement.
