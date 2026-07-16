---
name: Supabase RLS lessons
description: RLS pitfalls hit in this project and the required patterns
---
- profiles admin policies must use the security-definer fn `public.is_admin()`; a subquery on profiles inside a profiles policy causes infinite recursion (42P17).
- api-server has NO service-role key: any RLS-protected read (e.g. profiles in requireMember) must use `getUserSupabase(token)` (user-scoped client), not the anon `getSupabase()` client — anon reads return empty → false PROFILE_NOT_FOUND.
- watchlist_items/market_cache have no anon/user policies by design → server-key only; blocked until SUPABASE_SERVICE_ROLE_KEY is added (never ask for the value in chat; use requestSecrets).
- User runs all migrations manually in Supabase SQL Editor; keep migrations idempotent, include auth.users→profiles backfill, never destructive.
- Test accounts p2테스트봇 / p2테스트봇2 exist (pending) for role testing; login_name → deterministic email u-<sha256[0:20] of "seungjae-stock-account:<name>">@accounts.seungjae-stock.com.
**How to apply:** when adding tables/policies, gate member tables with `auth.uid() = member_id and public.is_approved_member()`.
