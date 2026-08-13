do $$
begin
  if to_regclass('public.toss_readonly_connections') is not null then
    raise exception 'toss_readonly_connections remained after rollback';
  end if;
end
$$;
