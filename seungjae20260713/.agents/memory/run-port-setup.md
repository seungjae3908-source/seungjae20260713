---
name: Run/port setup
description: Which workflow serves the user's public URL, port mappings, and how to verify the served bundle
---

- Public URL (external 80) maps to **local 8080**, served only by the `api-server: API Server` workflow (build + Express serving stock-analyzer/dist/public). The `앱 전체 실행` workflow serves the same dist on **PORT=3001** (external 3001) — it does NOT back the public URL.
- **Why:** user reported "changes not visible on phone" — root cause was no process on 8080; the PWA service worker kept showing the cached old bundle since no server delivered a new sw.js.
- **How to apply:** after frontend changes, run the build and restart `api-server: API Server`, then verify with `curl https://$REPLIT_DEV_DOMAIN/ | grep assets/index-` that the public URL serves the new bundle hash. Cache-control on index.html is max-age=0 and sw.js uses skipWaiting+clientsClaim+cleanupOutdatedCaches, so clients update on next online refresh.
- api-server dev process does NOT hot-reload src changes — restart the workflow after editing api-server code.
- KIWOOM_MODE=mock is mandatory (no real trading).
- Watch out: an auto-commit once contained corrupted sources (merge-marker remnants, typos like `retun`) — `git status` clean does NOT mean buildable. Run `npx -p typescript tsc -p stock-analyzer --noEmit` before trusting HEAD; restore broken files from the last commit that passes tsc.
- Approved wording: US market toggle label is 해외 (not 미국).
