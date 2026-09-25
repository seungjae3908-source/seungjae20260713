begin;

alter table public.telegram_signal_followup_ledger
  drop constraint if exists telegram_signal_followup_message_bundle_check,
  drop constraint if exists telegram_signal_followup_base_message_check,
  drop constraint if exists telegram_signal_followup_message_kind_check,
  drop constraint if exists telegram_signal_followup_message_id_check,
  drop column if exists base_message_text,
  drop column if exists telegram_message_kind,
  drop column if exists telegram_message_id;

commit;
