-- Preserve the existing public OPEN MIC screens and public host announcements.
create or replace view public.events_public with(security_barrier=true) as
  select id,created_at,title,event_type,event_date,start_time,end_time,location,location_id,image_url,
    somoim_apply_enabled,somoim_apply_url,description,host_note,somoim_open_at,somoim_open_enabled
  from public.events where event_type in('VOM LIVE','BUSKING','OPEN MIC')
    or (event_type='OTHER' and (upper(title) like '%OPEN MIC%' or title like '%대관공연%'));
grant select on public.events_public to anon,authenticated;
