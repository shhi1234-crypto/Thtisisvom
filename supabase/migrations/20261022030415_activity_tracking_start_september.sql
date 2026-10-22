-- VOM activity management starts on 2026-09-01.
-- Records before the launch date remain historical only and never advance a member's
-- activity deadline. Future planned attendance remains excluded as well.
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
  where src.attended_on >= date '2026-09-01'
    and src.attended_on <= (now() at time zone 'Asia/Seoul')::date;
$function$;

revoke all on function private.vom_member_last_attended(bigint) from public;
