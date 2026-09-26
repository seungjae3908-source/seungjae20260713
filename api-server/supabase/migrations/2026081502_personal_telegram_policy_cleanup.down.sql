-- Security cleanup is intentionally non-reversible: rollback stays fail-closed.
begin;

do $personal_telegram_policy_cleanup_down$
declare
  target_table text;
  policy_name text;
begin
  foreach target_table in array array[
    'telegram_connections',
    'telegram_link_tokens',
    'user_execution_events',
    'notification_deliveries'
  ]
  loop
    if to_regclass(format('public.%I', target_table)) is null then
      continue;
    end if;

    for policy_name in
      select pol.polname
      from pg_policy pol
      where pol.polrelid = format('public.%I', target_table)::regclass
    loop
      execute format('drop policy %I on public.%I', policy_name, target_table);
    end loop;

    execute format(
      'create policy %I on public.%I for all using (false) with check (false)',
      target_table || '_server_only',
      target_table
    );
    execute format('alter table public.%I enable row level security', target_table);
    execute format('revoke all privileges on table public.%I from public, anon, authenticated', target_table);
    execute format('grant all privileges on table public.%I to service_role', target_table);
  end loop;
end
$personal_telegram_policy_cleanup_down$;

commit;
