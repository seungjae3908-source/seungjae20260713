-- Public Telegram signal messages are updated in place instead of emitting a
-- new message for every TP/stop/lifecycle change. Only the Telegram message id,
-- media kind and original public caption/text are stored. No member/chat/account
-- identity or trading authority is stored here.
begin;

alter table public.telegram_signal_followup_ledger
  add column if not exists telegram_message_id bigint,
  add column if not exists telegram_message_kind text,
  add column if not exists base_message_text text;

alter table public.telegram_signal_followup_ledger
  drop constraint if exists telegram_signal_followup_message_id_check,
  add constraint telegram_signal_followup_message_id_check check (
    telegram_message_id is null or telegram_message_id > 0
  ),
  drop constraint if exists telegram_signal_followup_message_kind_check,
  add constraint telegram_signal_followup_message_kind_check check (
    telegram_message_kind is null or telegram_message_kind in ('TEXT','PHOTO')
  ),
  drop constraint if exists telegram_signal_followup_base_message_check,
  add constraint telegram_signal_followup_base_message_check check (
    base_message_text is null or char_length(base_message_text) between 1 and 4096
  ),
  drop constraint if exists telegram_signal_followup_message_bundle_check,
  add constraint telegram_signal_followup_message_bundle_check check (
    (telegram_message_id is null and telegram_message_kind is null and base_message_text is null)
    or
    (telegram_message_id is not null and telegram_message_kind is not null and base_message_text is not null)
  );

comment on column public.telegram_signal_followup_ledger.telegram_message_id is
  'Telegram public-room message id used only for edit-in-place lifecycle updates.';
comment on column public.telegram_signal_followup_ledger.telegram_message_kind is
  'TEXT or PHOTO so the server chooses editMessageText vs editMessageCaption.';
comment on column public.telegram_signal_followup_ledger.base_message_text is
  'Original public signal text/caption; no member, account, chat id, or private trading data.';

commit;
