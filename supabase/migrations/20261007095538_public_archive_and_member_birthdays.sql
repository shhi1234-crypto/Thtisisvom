-- A boolean predicate lets archive rows be read without granting access to raw events.
create function private.vom_can_view_event(p_event_id bigint) returns boolean
language sql stable security definer set search_path='' as $$
  select case when (select auth.uid()) is not null and private.vom_is_approved() then true
  else exists(select 1 from public.events e where e.id=p_event_id
    and e.event_date<(current_timestamp at time zone 'Asia/Seoul')::date
    and (e.event_type in('VOM LIVE','BUSKING','OPEN MIC')
      or (e.event_type='OTHER' and (upper(e.title) like '%OPEN MIC%' or e.title like '%대관공연%')))) end;
$$;
revoke all on function private.vom_can_view_event(bigint) from public;
grant usage on schema private to anon;
grant execute on function private.vom_can_view_event(bigint) to anon,authenticated;

-- Upcoming schedules remain available to verified members, while visitors see archives.
create or replace view public.events_public with(security_barrier=true) as
  select id,created_at,title,event_type,event_date,start_time,end_time,location,location_id,image_url,
    somoim_apply_enabled,somoim_apply_url,description,host_note,somoim_open_at,somoim_open_enabled
  from public.events where
    (event_type in('VOM LIVE','BUSKING','OPEN MIC')
      or (event_type='OTHER' and (upper(title) like '%OPEN MIC%' or title like '%대관공연%')))
    and private.vom_can_view_event(id);


do $$declare table_name text;begin
  foreach table_name in array array['live_participants','live_results','busking_setlist_direct_songs','busking_setlist_items','busking_setlist_order','busking_setlist_settings','busking_setlist_slots'] loop
    if to_regclass('public.'||table_name) is not null then
      execute format('alter table public.%I enable row level security',table_name);
      execute format('create policy "schedule visibility boundary" on public.%I as restrictive for select to anon,authenticated using(private.vom_can_view_event(event_id))',table_name);
      -- Explicitly allow participant reads within the same archive/member boundary.
      if table_name='live_participants' then
        execute format('create policy "archive and member participant read" on public.%I for select to anon,authenticated using(private.vom_can_view_event(event_id))',table_name);
      end if;
    end if;
  end loop;
  if to_regclass('public.busking_setlist_slot_songs') is not null then
    alter table public.busking_setlist_slot_songs enable row level security;
    create policy "schedule visibility boundary" on public.busking_setlist_slot_songs as restrictive for select to anon,authenticated
      using(exists(select 1 from public.busking_setlist_slots s where s.id=slot_id and private.vom_can_view_event(s.event_id)));
  end if;
end $$;

-- Definer views also need the boundary; base-table RLS alone cannot protect them.
do $$declare view_name text;definition text;begin
  foreach view_name in array array['live_vote_breakdown','live_event_points'] loop
    if to_regclass('public.'||view_name) is not null then
      definition:=rtrim(pg_get_viewdef(('public.'||view_name)::regclass,true),';'||chr(10)||' ');
      execute format('create or replace view public.%I with(security_barrier=true) as select * from (%s) visible where private.vom_can_view_event(visible.event_id)',view_name,definition);
    end if;
  end loop;
  if to_regclass('public.live_point_hall_of_fame') is not null then
    definition:=pg_get_viewdef('public.live_point_hall_of_fame'::regclass,true);
    if position('live_results lr' in definition)=0 then raise exception 'unexpected_hall_of_fame_definition';end if;
    definition:=regexp_replace(definition,'(public[.])?live_results lr','(select * from public.live_results where private.vom_can_view_event(event_id)) lr','g');
    execute 'create or replace view public.live_point_hall_of_fame with(security_barrier=true) as '||definition;
  end if;
end $$;
