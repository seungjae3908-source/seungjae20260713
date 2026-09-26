---
name: Screenshot verify harness
description: How to visually verify the production build on 8080 despite the PWA service worker
---

- The screenshot browser persists service workers across calls: after the first load of the app on an origin, the SW NavigationRoute hijacks any custom harness HTML path (serves index.html → app 404 page).
- **Workaround:** SW denylist is `/^\/api/` — temporarily add `app.get('/api/__vp', sendFile(harness))` to api-server (before apiRouter), screenshot via `/api/__vp?p=<path>&sc=<scroll>&clk=<buttonText|buttonText2>`, then delete the route and restart.
- Harness features that work: 3 iframes (360/390/412), Supabase token injection into localStorage, interval-based scroll (`sc`), and sequential button clicks by textContent (`clk`, `|`-separated) — enables testing collapse/expand states.
- Always delete `__vp.html` from public/ and dist/public/ after use (contains session token).
