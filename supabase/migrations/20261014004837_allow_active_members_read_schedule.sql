-- Active members may read the shared schedule before completing first-login password change.
create or replace function private.vom_is_approved()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists(
    select 1
    from public.admins
    where user_id = (select auth.uid())
  ) or exists(
    select 1
    from public.members m
    where m.auth_user_id = (select auth.uid())
      and m.is_active is true
  );
$function$;