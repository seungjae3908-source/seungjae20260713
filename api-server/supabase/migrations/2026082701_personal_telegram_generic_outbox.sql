-- Extend the existing server-only personal Telegram outbox instead of creating
-- a competing delivery queue. Existing execution-event deliveries remain valid;
-- personal investment alerts may persist a sanitized alert payload without an
-- execution-event foreign key.
begin;

alter table public.notification_deliveries
  add column if not exists delivery_kind text;

update public.notification_deliveries
set delivery_kind = 'EXECUTION_EVENT'
where delivery_kind is null;

alter table public.notification_deliveries
  alter column delivery_kind set default 'EXECUTION_EVENT',
  alter column delivery_kind set not null,
  alter column event_id drop not null,
  add column if not exists payload jsonb;

do $personal_telegram_generic_outbox_contract$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notification_deliveries'::regclass
      and conname = 'notification_deliveries_kind_check'
  ) then
    alter table public.notification_deliveries
      add constraint notification_deliveries_kind_check
      check (delivery_kind in ('EXECUTION_EVENT', 'PERSONAL_ALERT'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notification_deliveries'::regclass
      and conname = 'notification_deliveries_payload_contract_check'
  ) then
    alter table public.notification_deliveries
      add constraint notification_deliveries_payload_contract_check
      check (
        (delivery_kind = 'EXECUTION_EVENT' and event_id is not null and payload is null)
        or
        (delivery_kind = 'PERSONAL_ALERT' and event_id is null and jsonb_typeof(payload) = 'object')
      );
  end if;
end
$personal_telegram_generic_outbox_contract$;

create index if not exists notification_deliveries_personal_history_idx
  on public.notification_deliveries(user_id, updated_at desc)
  where delivery_kind = 'PERSONAL_ALERT' and state = 'SENT';

-- Preserve the existing server-only security boundary explicitly.
alter table public.notification_deliveries enable row level security;
revoke all privileges on table public.notification_deliveries from public, anon, authenticated;
grant all privileges on table public.notification_deliveries to service_role;

commit;
