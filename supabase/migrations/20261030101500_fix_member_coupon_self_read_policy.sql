-- Ensure coupon RLS can resolve the logged-in member without requiring
-- direct SELECT privileges on the private members table.

create or replace function private.vom_current_member_id()
returns bigint
language sql
stable
security definer
set search_path = ''
as $function$
  select m.id
  from public.members as m
  where m.auth_user_id = auth.uid()
  limit 1;
$function$;

revoke all on function private.vom_current_member_id() from public;
grant execute on function private.vom_current_member_id() to authenticated;

drop policy if exists "members read their own coupons" on public.member_coupons;
create policy "members read their own coupons"
  on public.member_coupons
  for select
  to authenticated
  using (
    member_id = (select private.vom_current_member_id())
  );
