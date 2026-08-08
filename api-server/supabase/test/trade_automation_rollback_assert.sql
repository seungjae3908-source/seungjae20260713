\set ON_ERROR_STOP on
do $trade_rollback$
declare candidate_table text;
begin
  foreach candidate_table in array array[
    'trade_system_controls', 'trade_automation_profiles', 'trade_exchange_connections', 'trade_order_plans',
    'trade_orders', 'trade_order_events'
  ] loop
    if to_regclass('public.' || candidate_table) is not null then
      raise exception 'trade automation rollback left table %', candidate_table;
    end if;
  end loop;
end
$trade_rollback$;
