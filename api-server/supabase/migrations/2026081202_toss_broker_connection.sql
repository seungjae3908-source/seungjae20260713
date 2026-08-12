-- Allow member-owned Toss Securities credentials in the existing encrypted
-- broker connection vault. Trading order rows remain limited to the execution
-- providers supported by the order engine.
--
-- 2026080506 intentionally made the auto-trading tables administrator-only,
-- but broker connection metadata is a separate member-owned concern. Restore
-- the original regular/admin owner boundary for this table only; encrypted
-- credentials remain protected by the existing column-level privilege model.
begin;

alter table public.trade_exchange_connections
  drop constraint if exists trade_exchange_connections_exchange_check;

alter table public.trade_exchange_connections
  add constraint trade_exchange_connections_exchange_check
  check (exchange in ('toss', 'kiwoom', 'upbit', 'bitget'));

do $member_owned_broker_connection_rls$
declare
  member_owner_only text := '(auth.uid() = user_id and public.current_membership_level() in (''regular'', ''admin''))';
begin
  drop policy if exists "trade_exchange_connections select own" on public.trade_exchange_connections;
  create policy "trade_exchange_connections select own"
    on public.trade_exchange_connections for select
    using (auth.uid() = user_id and public.current_membership_level() in ('regular', 'admin'));

  drop policy if exists "trade_exchange_connections insert own" on public.trade_exchange_connections;
  create policy "trade_exchange_connections insert own"
    on public.trade_exchange_connections for insert
    with check (auth.uid() = user_id and public.current_membership_level() in ('regular', 'admin'));

  drop policy if exists "trade_exchange_connections update own" on public.trade_exchange_connections;
  create policy "trade_exchange_connections update own"
    on public.trade_exchange_connections for update
    using (auth.uid() = user_id and public.current_membership_level() in ('regular', 'admin'))
    with check (auth.uid() = user_id and public.current_membership_level() in ('regular', 'admin'));

  drop policy if exists "trade_exchange_connections delete own" on public.trade_exchange_connections;
  create policy "trade_exchange_connections delete own"
    on public.trade_exchange_connections for delete
    using (auth.uid() = user_id and public.current_membership_level() in ('regular', 'admin'));
end
$member_owned_broker_connection_rls$;

commit;