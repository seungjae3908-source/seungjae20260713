---
name: API route auth policy
description: Which api-server routes are public vs auth-gated and why
---
Public (no auth): health, market/*, quotes, search, news/:ticker, crypto/* (read-only public data), /kiwoom/status, /kiwoom/quote, /kiwoom/rankings.
Auth-gated (requireMember): watchlist (deviceId is client-supplied — trusting it unauthenticated = IDOR; a code review flagged this), push, stocks/*, backup.
Admin-only: /kiwoom/egress-ip, /kiwoom/token-test, /kiwoom/test, /kiwoom/raw-ranking, POST /kiwoom/token/refresh (operational/token-lifecycle endpoints, abuse of upstream quota), /debug, /admin.
**Why:** July 2026 route reordering to make market data public accidentally exposed watchlist writes and Kiwoom ops endpoints; fixed by per-route guards.
**How to apply:** When adding routes, decide public vs gated per this policy; never trust client-supplied deviceId as identity.
