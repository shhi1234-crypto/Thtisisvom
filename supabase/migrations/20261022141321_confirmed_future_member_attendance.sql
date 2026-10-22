-- Administrators may confirm a future attendance date in advance so the
-- member's 60-day activity cycle is visible immediately. Event participant
-- rows remain excluded until their event date actually arrives.
create or replace function private.vom_member_last_attended(p_member_id bigint)
returns date
language sql
stable
security definer
set search_path = public, private, pg_temp
as $function$
  select max(src.attended_on)::date
  from (
    select m.last_attendance_manual_at as attended_on, true as is_confirmed_manual
    from public.members m
    where m.id = p_member_id

    union all

    select e.event_date, false as is_confirmed_manual
    from public.live_participants lp
    join public.events e on e.id = lp.event_id
    where lp.member_id = p_member_id

    union all

    select e.event_date, false as is_confirmed_manual
    from public.busking_setlist_slots bs
    join public.events e on e.id = bs.event_id
    where bs.member_id = p_member_id::text

    union all

    select e.event_date, false as is_confirmed_manual
    from public.busking_setlist_direct_songs ds
    join public.events e on e.id = ds.event_id
    where ds.owner_member_id = p_member_id::text

    union all

    select e.event_date, false as is_confirmed_manual
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
    and (
      src.is_confirmed_manual
      or src.attended_on <= (now() at time zone 'Asia/Seoul')::date
    );
$function$;

revoke all on function private.vom_member_last_attended(bigint) from public;

