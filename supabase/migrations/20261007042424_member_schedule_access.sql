-- Apply after the compatible frontend is live. No member/event rows are deleted.
drop policy "members public profile read" on public.members;
create policy "member reads own private record" on public.members for select to authenticated
  using(auth_user_id=(select auth.uid()));

-- The member directory exposes personal fields only to their owner or admins.
create function private.vom_member_profiles() returns table(
  id bigint,created_at timestamptz,name text,nickname text,profile_image_url text,joined_at date,
  is_active boolean,role text,birth_date date,region text,gender text,favorite_singers text,join_order integer,job text
) language sql stable security definer set search_path='' as $$
  select m.id,m.created_at,m.name,m.nickname,m.profile_image_url,m.joined_at,m.is_active,m.role,
    case when m.auth_user_id=(select auth.uid()) or exists(select 1 from public.admins where user_id=(select auth.uid())) then m.birth_date end,
    case when m.auth_user_id=(select auth.uid()) or exists(select 1 from public.admins where user_id=(select auth.uid())) then m.region end,
    case when m.auth_user_id=(select auth.uid()) or exists(select 1 from public.admins where user_id=(select auth.uid())) then m.gender end,
    case when m.auth_user_id=(select auth.uid()) or exists(select 1 from public.admins where user_id=(select auth.uid())) then m.favorite_singers end,
    m.join_order,
    case when m.auth_user_id=(select auth.uid()) or exists(select 1 from public.admins where user_id=(select auth.uid())) then m.job end
  from public.members m where (select private.vom_is_approved());
$$;
revoke all on function private.vom_member_profiles() from public,anon;
grant execute on function private.vom_member_profiles() to authenticated;
create or replace view public.members_public with(security_invoker=true,security_barrier=true) as
  select * from private.vom_member_profiles();
revoke all on public.members_public from anon;
grant select on public.members_public to authenticated;

drop policy "everyone can read events" on public.events;
create policy "approved members read schedule" on public.events for select to authenticated
  using((select private.vom_is_approved()));
