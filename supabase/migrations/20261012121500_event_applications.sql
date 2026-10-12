-- November 2026 VOM website applications. Existing events remain opt-in (disabled).
alter table public.events
  add column if not exists application_enabled boolean not null default false,
  add column if not exists application_capacity integer,
  add column if not exists application_opens_at timestamptz,
  add column if not exists application_closes_at timestamptz;
alter table public.events
  add constraint vom_event_application_capacity_positive check (application_capacity is null or application_capacity between 1 and 500),
  add constraint vom_event_application_window_order check (application_opens_at is null or application_closes_at is null or application_opens_at < application_closes_at);

create table public.event_applications (
  id bigint generated always as identity primary key,
  event_id bigint not null references public.events(id) on delete restrict,
  member_id bigint not null references public.members(id) on delete restrict,
  status text not null default 'APPLIED' check(status in ('APPLIED','CONFIRMED','CANCELLED')),
  applied_at timestamptz not null default now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint vom_event_application_once unique(event_id,member_id)
);
create index event_applications_active_idx on public.event_applications(event_id,status);
alter table public.event_applications enable row level security;
revoke all on public.event_applications from public, anon, authenticated;
grant all on public.event_applications to service_role;
grant usage, select on sequence public.event_applications_id_seq to service_role;

-- All writes are through the authenticated Edge Function, which verifies the user's identity.
-- The events row lock makes concurrent applications respect capacity.
create or replace function public.vom_event_application_change(
  p_event_id bigint, p_member_id bigint, p_action text
) returns jsonb language plpgsql security definer
set search_path=public,pg_temp
as $$
declare
  ev public.events%rowtype;
  found_app public.event_applications%rowtype;
  active_count integer;
  result_app public.event_applications%rowtype;
begin
  if p_action not in ('apply','cancel') then
    raise exception 'unsupported_application_action' using errcode='P0001';
  end if;
  select * into ev from public.events where id=p_event_id for update;
  if not found then raise exception 'event_not_found' using errcode='P0001'; end if;
  if not exists(select 1 from public.members where id=p_member_id and is_active and auth_user_id is not null) then
    raise exception 'member_not_active' using errcode='P0001';
  end if;
  select * into found_app from public.event_applications where event_id=p_event_id and member_id=p_member_id;
  if p_action='cancel' then
    if found_app.id is null or found_app.status='CANCELLED' then
      raise exception 'application_not_found' using errcode='P0001';
    end if;
    update public.event_applications
      set status='CANCELLED', cancelled_at=now(), confirmed_at=null, updated_at=now()
      where id=found_app.id returning * into result_app;
    return jsonb_build_object('status',result_app.status,'id',result_app.id);
  end if;

  if ev.event_date < date '2026-11-01' or not ev.application_enabled
    or ev.application_capacity is null then
    raise exception 'applications_not_enabled' using errcode='P0001';
  end if;
  if now() < timestamptz '2026-10-19 20:00:00+09'
    or (ev.application_opens_at is not null and now()<ev.application_opens_at) then
    raise exception 'applications_not_open' using errcode='P0001';
  end if;
  if ev.event_date <= (now() at time zone 'Asia/Seoul')::date
    or (ev.application_closes_at is not null and now()>=ev.application_closes_at) then
    raise exception 'applications_closed' using errcode='P0001';
  end if;
  if found_app.id is not null and found_app.status in ('APPLIED','CONFIRMED') then
    return jsonb_build_object('status',found_app.status,'id',found_app.id);
  end if;
  select count(*) into active_count from public.event_applications
    where event_id=p_event_id and status in ('APPLIED','CONFIRMED');
  if active_count >= ev.application_capacity then
    raise exception 'applications_full' using errcode='P0001';
  end if;
  if found_app.id is not null then
    update public.event_applications
      set status='APPLIED', applied_at=now(), confirmed_at=null, cancelled_at=null, updated_at=now()
      where id=found_app.id returning * into result_app;
  else
    insert into public.event_applications(event_id,member_id)
      values(p_event_id,p_member_id) returning * into result_app;
  end if;
  return jsonb_build_object('status',result_app.status,'id',result_app.id);
end;
$$;
revoke all on function public.vom_event_application_change(bigint,bigint,text) from public, anon, authenticated;
grant execute on function public.vom_event_application_change(bigint,bigint,text) to service_role;
