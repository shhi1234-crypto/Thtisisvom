begin;

create or replace view public.ear_share_best as
with cumulative as (
  select
    name,
    sum(votes)::integer as votes,
    sum(participant_count)::integer as participant_count,
    count(distinct event_id)::integer as event_count,
    round(
      (sum(votes)::numeric / nullif(sum(participant_count), 0)) * 100,
      1
    ) as ear_share_percent
  from public.ear_share_records
  group by name
),
latest_event as (
  select distinct on (name)
    name,
    event_id,
    event_title,
    event_date
  from public.ear_share_records
  order by name, event_date desc nulls last, event_id desc
)
select
  cumulative.name,
  cumulative.ear_share_percent,
  cumulative.votes,
  cumulative.participant_count,
  latest_event.event_id,
  latest_event.event_title,
  latest_event.event_date,
  cumulative.event_count
from cumulative
join latest_event using (name);

create or replace view public.ear_share_hall_of_fame as
select
  name,
  ear_share_percent,
  votes,
  participant_count,
  event_id,
  event_title,
  event_date,
  dense_rank() over (order by ear_share_percent desc) as rank,
  event_count
from public.ear_share_best;

commit;
