-- Approved VOM members can see the low-sensitivity directory profile fields
-- (activity region, favorite singers, and job) of other approved active members.
-- Birth date, gender, phone, photos, notes, and review data remain private.

create or replace function private.vom_member_profiles()
returns table(
  id bigint,
  created_at timestamptz,
  name text,
  nickname text,
  profile_image_url text,
  joined_at date,
  is_active boolean,
  role text,
  birth_date date,
  region text,
  gender text,
  favorite_singers text,
  join_order integer,
  job text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    m.id,
    m.created_at,
    m.name,
    m.nickname,
    m.profile_image_url,
    m.joined_at,
    m.is_active,
    m.role,
    case
      when m.auth_user_id = (select auth.uid())
        or exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
      then m.birth_date
    end,
    m.region,
    case
      when m.auth_user_id = (select auth.uid())
        or exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
      then m.gender
    end,
    m.favorite_singers,
    m.join_order,
    m.job
  from public.members m
  where (select private.vom_is_approved());
$function$;

revoke all on function private.vom_member_profiles() from public;
grant execute on function private.vom_member_profiles() to authenticated;
