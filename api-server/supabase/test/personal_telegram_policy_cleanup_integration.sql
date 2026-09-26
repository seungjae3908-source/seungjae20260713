-- Reproduce legacy self-read policies, then prove the cleanup migration removes them.
drop policy if exists "telegram_connections select own" on public.telegram_connections;
create policy "telegram_connections select own" on public.telegram_connections
  for select using (auth.uid() = user_id);
drop policy if exists "user_execution_events select own" on public.user_execution_events;
create policy "user_execution_events select own" on public.user_execution_events
  for select using (auth.uid() = user_id);
drop policy if exists "notification_deliveries select own" on public.notification_deliveries;
create policy "notification_deliveries select own" on public.notification_deliveries
  for select using (auth.uid() = user_id);

\ir ../migrations/2026081502_personal_telegram_policy_cleanup.sql

do $personal_telegram_policy_cleanup_integration$
declare
  target_table text;
begin
  foreach target_table in array array[
    'telegram_connections',
    'telegram_link_tokens',
    'user_execution_events',
    'notification_deliveries'
  ]
  loop
    if (
      select count(*) <> 1
        or bool_or(policyname <> (target_table || '_server_only'))
        or bool_or(cmd <> 'ALL')
        or bool_or(qual <> 'false')
        or bool_or(with_check <> 'false')
      from pg_policies
      where schemaname = 'public' and tablename = target_table
    ) then
      raise exception 'legacy policy survived cleanup on public.%', target_table;
    end if;
    if exists (
      select 1 from information_schema.table_privileges privilege
      where privilege.table_schema = 'public'
        and privilege.table_name = target_table
        and privilege.grantee in ('PUBLIC', 'anon', 'authenticated')
    ) then
      raise exception 'API role privilege survived cleanup on public.%', target_table;
    end if;
  end loop;
end
$personal_telegram_policy_cleanup_integration$;
