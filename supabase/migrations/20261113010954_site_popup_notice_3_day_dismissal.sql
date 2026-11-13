-- Admin-managed public announcement popup.
-- Public visitors can read only an active, populated notice; admins manage the singleton row.
create table public.site_popup_notice (
  id smallint primary key default 1 check (id = 1),
  title text not null default '' check (char_length(title) <= 120),
  body text not null default '' check (char_length(body) <= 3000),
  link_label text check (link_label is null or char_length(link_label) <= 40),
  link_url text check (link_url is null or char_length(link_url) <= 500),
  is_active boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.site_popup_notice enable row level security;

grant select (id, title, body, link_label, link_url, is_active, updated_at)
  on table public.site_popup_notice to anon, authenticated;
grant insert, update on table public.site_popup_notice to authenticated;

create policy "site_popup_notice_public_read_active"
on public.site_popup_notice
for select
to anon, authenticated
using (
  is_active
  and char_length(btrim(title)) > 0
  and char_length(btrim(body)) > 0
);

create policy "site_popup_notice_admin_read"
on public.site_popup_notice
for select
to authenticated
using (
  exists (
    select 1 from public.admins
    where admins.user_id = (select auth.uid())
  )
);

create policy "site_popup_notice_admin_insert"
on public.site_popup_notice
for insert
to authenticated
with check (
  exists (
    select 1 from public.admins
    where admins.user_id = (select auth.uid())
  )
);

create policy "site_popup_notice_admin_update"
on public.site_popup_notice
for update
to authenticated
using (
  exists (
    select 1 from public.admins
    where admins.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.admins
    where admins.user_id = (select auth.uid())
  )
);

insert into public.site_popup_notice (id) values (1)
on conflict (id) do nothing;

