begin;

create table if not exists public.vom_campaigns (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) > 0),
  campaign_type text not null check (campaign_type in ('POINT', 'EAR', 'MISSION')),
  start_date date not null,
  end_date date not null,
  point_cost integer not null default 0 check (point_cost >= 0),
  reward_points integer not null default 0 check (reward_points >= 0),
  image_url text,
  description text not null default '',
  force_closed boolean not null default false,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vom_campaigns_valid_dates check (end_date >= start_date)
);

create index if not exists vom_campaigns_period_idx
  on public.vom_campaigns (start_date desc, end_date desc);

alter table public.vom_campaigns enable row level security;

drop policy if exists "campaigns public read" on public.vom_campaigns;
drop policy if exists "campaigns admin insert" on public.vom_campaigns;
drop policy if exists "campaigns admin update" on public.vom_campaigns;
drop policy if exists "campaigns admin delete" on public.vom_campaigns;

create policy "campaigns public read"
on public.vom_campaigns
for select
to anon, authenticated
using (true);

create policy "campaigns admin insert"
on public.vom_campaigns
for insert
to authenticated
with check (
  exists (
    select 1
    from public.admins a
    where a.user_id = (select auth.uid())
  )
);

create policy "campaigns admin update"
on public.vom_campaigns
for update
to authenticated
using (
  exists (
    select 1
    from public.admins a
    where a.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.admins a
    where a.user_id = (select auth.uid())
  )
);

create policy "campaigns admin delete"
on public.vom_campaigns
for delete
to authenticated
using (
  exists (
    select 1
    from public.admins a
    where a.user_id = (select auth.uid())
  )
);

commit;
