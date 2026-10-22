-- Member attendance is derived from actual past/today participation, with an
-- editable staff-entered history for attendance recorded before this feature.
alter table public.members
  add column if not exists last_attendance_manual_at date;

comment on column public.members.last_attendance_manual_at is
  'Staff-entered historical attendance date; effective attendance also includes actual event participation.';

create index if not exists live_participants_member_event_idx
  on public.live_participants (member_id, event_id)
  where member_id is not null;

create index if not exists busking_setlist_slots_member_event_idx
  on public.busking_setlist_slots (member_id, event_id);

create or replace function private.vom_member_last_attended(p_member_id bigint)
returns date
language sql
stable
security definer
set search_path = public, private, pg_temp
as $function$
  select max(src.attended_on)::date
  from (
    select m.last_attendance_manual_at as attended_on
    from public.members m
    where m.id = p_member_id

    union all

    select e.event_date
    from public.live_participants lp
    join public.events e on e.id = lp.event_id
    where lp.member_id = p_member_id

    union all

    select e.event_date
    from public.busking_setlist_slots bs
    join public.events e on e.id = bs.event_id
    where bs.member_id = p_member_id::text

    union all

    select e.event_date
    from public.busking_setlist_direct_songs ds
    join public.events e on e.id = ds.event_id
    where ds.owner_member_id = p_member_id::text

    union all

    select e.event_date
    from public.busking_setlist_direct_songs ds
    join public.events e on e.id = ds.event_id
    cross join lateral jsonb_array_elements_text(
      case
        when jsonb_typeof(ds.participant_ids) = 'array' then ds.participant_ids
        else '[]'::jsonb
      end
    ) as participant(member_id)
    where participant.member_id = p_member_id::text
  ) src
  -- A future setlist/participant entry is a planned appearance, not attendance.
  where src.attended_on <= (now() at time zone 'Asia/Seoul')::date;
$function$;

revoke all on function private.vom_member_last_attended(bigint) from public;

drop view if exists public.members_public;
drop function if exists private.vom_member_profiles();

create function private.vom_member_profiles()
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
  job text,
  last_attended_at date
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
    m.job,
    private.vom_member_last_attended(m.id)
  from public.members m
  where (select private.vom_is_approved());
$function$;

revoke all on function private.vom_member_profiles() from public;
grant execute on function private.vom_member_profiles() to authenticated, service_role;

create view public.members_public
with (security_invoker = true, security_barrier = true) as
select
  id,
  created_at,
  name,
  nickname,
  profile_image_url,
  joined_at,
  is_active,
  role,
  birth_date,
  region,
  gender,
  favorite_singers,
  join_order,
  job,
  last_attended_at
from private.vom_member_profiles();

grant select on public.members_public to authenticated, service_role;