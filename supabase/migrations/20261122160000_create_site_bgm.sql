begin;

create table if not exists public.site_bgm_tracks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  artist text not null default '',
  category text not null default 'ETC' check (category in ('OST','KPOP','POP','JAZZ','ETC')),
  file_path text not null unique,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.site_bgm_tracks enable row level security;
revoke all on public.site_bgm_tracks from anon, authenticated;
grant select on public.site_bgm_tracks to anon;
grant select, insert, update, delete on public.site_bgm_tracks to authenticated;

create policy "site bgm published read" on public.site_bgm_tracks
  for select to anon, authenticated using (is_active);
create policy "site bgm admin read" on public.site_bgm_tracks
  for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));
create policy "site bgm admin insert" on public.site_bgm_tracks
  for insert to authenticated
  with check (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));
create policy "site bgm admin update" on public.site_bgm_tracks
  for update to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())))
  with check (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));
create policy "site bgm admin delete" on public.site_bgm_tracks
  for delete to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-bgm', 'site-bgm', true, 52428800,
  array['audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-wav','audio/ogg','audio/webm','audio/flac'])
on conflict (id) do nothing;

create policy "site bgm public read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'site-bgm');
create policy "site bgm admin upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'site-bgm' and exists (select 1 from public.admins a where a.user_id = (select auth.uid())));
create policy "site bgm admin delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'site-bgm' and exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

commit;

