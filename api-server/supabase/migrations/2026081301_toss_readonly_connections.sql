-- Server-only encrypted credential storage for Toss Securities read-only account access.
-- Browser roles receive no table privileges. The authenticated API route resolves
-- the current user first, then the server service role accesses only that user_id.
begin;

create table if not exists public.toss_readonly_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_credentials text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint toss_readonly_connections_encrypted_nonempty
    check (length(trim(encrypted_credentials)) > 0)
);

alter table public.toss_readonly_connections enable row level security;

revoke all privileges on table public.toss_readonly_connections from public;
revoke all privileges on table public.toss_readonly_connections from anon;
revoke all privileges on table public.toss_readonly_connections from authenticated;

-- Intentionally no anon/authenticated RLS policy. Direct browser access remains
-- denied even if a user knows their own user_id. Server service-role access is
-- scoped in the repository by an exact user_id predicate.

commit;
