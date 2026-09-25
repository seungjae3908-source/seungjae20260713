# Phase 3 — current-main reconciliation and real app verification

Existing owner #1042. The two-parent synchronization preserves the old owner
adfcb23baf956bcaa025f0846313faf8db7a4e4a and pinned main
7b16470111e813dbb4dca3aef8bba8e91c1a5231. This is a Draft branch update,
NOT PR merging, main modification, a rebase, deployment or activation.

The branch was 31 commits ahead / 2199 behind at intake. Its ancestor is
9057c4a3767db0f81e595fc481f5066bda6c9e43. Only the 33 original owner paths
and explicitly listed Phase3 test/compatibility paths may differ from main.
A Git-level verifier checks both ancestries, the allowed diff and exact hashes
of protected Paper/research, global auth, current Research Center and lockfile.

## Conflict resolutions

- API index: start from current main, retain auth/profile bootstrap and current
  capabilities, add only the video reader import and its authenticated mount.
- Source-reader smoke test and public-discovery workflow: main still equals the
  old common base; retain the owner additions. Public discovery remains skipped
  on synchronization, so this does not request new YouTube data.
- Video panel: preserve source default, Korean compact explanatory header and
  collapsible technical details; retain the owner's real sanitized source view
  and strategy/backtest subtab. Do not restore stale hardcoded provider counts.
- Browser tests: use current main's 요약/영상 buttons, not the obsolete 전문가
  보기/영상 연구 labels. Supply the new auth/profile response in fixtures.
- All unmodified main paths remain identical. Old source and snapshots stay in
  the existing branch ancestry; no force push or source deletion is used.

## Additional defect repair

Opening a FIFO with O_RDONLY before inspecting its type could wait forever.
The store now adds O_NONBLOCK to O_NOFOLLOW, rejects nonregular files before
reading, and tests named pipes for both policy and registry without hanging.
This is local research-reader hardening, not a production server mutation.

## Validation boundary

115 offline tests were executed locally and passed (109 baseline + 6 new).
Full frontend/backend semantic checks and actual Vite React/Tailwind browser
suite are configured in the dedicated CI, with no retry-to-pass. Browser API
and identity responses are synthetic; no live account/provider or financial
result is exercised. A separate test Vite config excludes Replit plugins and
uses the same app root, React and Tailwind. Production Vite config is unchanged.
The checks are not presumed successful until the exact HEAD's run is read back.

No registry publisher, provider AI invocation, 24h worker, schedule, Paper,
Telegram delivery, live order, profitability credit or adoption is activated.
Real trusted data publication and authorized video end-to-end remain pending.
