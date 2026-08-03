-- Verify the hosted Auth insert trigger contract without retaining any user data.
insert into auth.users(id, email, raw_user_meta_data)
values (
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  'bootstrap-trigger@test.invalid',
  '{"login_name":"bootstrap-trigger","display_name":"Bootstrap Trigger"}'::jsonb
);

do $verify_profile_trigger$
declare
  row_count integer;
begin
  select count(*) into row_count
  from public.profiles
  where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    and login_name = 'bootstrap-trigger'
    and display_name = 'Bootstrap Trigger'
    and membership_level = 'pending'
    and status = 'pending'
    and role = 'user'
    and is_active is true;
  if row_count <> 1 then
    raise exception 'staging bootstrap Auth trigger did not create the expected pending profile';
  end if;
end
$verify_profile_trigger$;

delete from auth.users where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

do $verify_profile_cascade$
begin
  if exists (
    select 1 from public.profiles
    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
  ) then
    raise exception 'staging bootstrap profile remained after Auth user deletion';
  end if;
end
$verify_profile_cascade$;
