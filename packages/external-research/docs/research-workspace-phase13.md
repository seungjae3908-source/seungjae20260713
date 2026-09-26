# Phase13 read-only operational preflight

Phase13 does not call Gemini or Groq and does not create or modify server state. It answers only whether the currently deployed Production process is ready for the separately approved Phase12 reviewed one-shot.

The preflight reads the single PM2 process named stock-app, verifies exact Production SHA and safe trading authority, classifies Gemini and Groq configuration without emitting credential values, and inspects a server-owned private root selected only by RESEARCH_WORKSPACE_ONE_SHOT_ROOT.

The root uses fixed basenames only: source.json, spec.json, manifest.json, video-approval.json, and groq-approval.json. Files must be regular, single-link, same-UID, non-symlink, private files. Approval plan digests and expiration windows are checked before readiness can become READY_FOR_REVIEWED_ONE_SHOT.

The workflow command is /research-workspace-one-shot-preflight <exact-current-main-sha> on the canonical Central Hub. It requires exact-main Required CI 6/6 and no active Production deployment race.

The sanitized result contains readiness states and blocker codes only. Provider calls, server writes/deletes/restarts, database changes, and collected secret values are all fixed at zero. executionAuthority remains NONE. A READY result is not permission to execute providers; the actual one-shot remains a separate operational action.
