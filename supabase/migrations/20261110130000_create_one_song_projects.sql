begin;

create table if not exists public.one_song_projects (
  id uuid primary key default gen_random_uuid(),
  round_number integer not null check (round_number between 1 and 999),
  song_title text not null check (char_length(btrim(song_title)) between 1 and 120),
  data jsonb not null default '{"version":1,"participants":[],"lines":[]}'::jsonb
    check (jsonb_typeof(data) = 'object'),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint one_song_projects_round_title_key unique (round_number, song_title)
);

alter table public.one_song_projects enable row level security;
revoke all on table public.one_song_projects from anon, public;
grant select, insert, update, delete on table public.one_song_projects to authenticated;

drop policy if exists "one_song_projects_admin_only" on public.one_song_projects;
drop policy if exists "one_song_projects_approved_members_only" on public.one_song_projects;
create policy "one_song_projects_approved_members_only"
on public.one_song_projects
for all
to authenticated
using ((select private.vom_is_approved()))
with check ((select private.vom_is_approved()));

with seed_data as (
  select jsonb_build_object(
    'version', 1,
    'participants', jsonb_build_array(
      jsonb_build_object('id','byeongchan','name','병찬','gender','male','textColor','#216f9d','additionalColor','#d9efff'),
      jsonb_build_object('id','dohee','name','도희','gender','female','textColor','#b33963','additionalColor','#ffe0eb'),
      jsonb_build_object('id','sihyeon','name','시현','gender',null,'textColor','#343c50','additionalColor','#edf0f5'),
      jsonb_build_object('id','young-eun','name','영은','gender','female','textColor','#b33963','additionalColor','#ffe0eb')
    ),
    'lines', (
      select jsonb_agg(
        jsonb_build_object(
          'id', 'must-have-love-02-' || lpad(n::text,2,'0'),
          'sectionTitle', case
            when n between 5 and 6 then '후렴'
            when n between 15 and 16 then '후렴'
            when n between 25 and 29 then '후렴'
            when n between 30 and 32 then '아웃트로'
            else ''
          end,
          'lyrics', '',
          'chorus', n = any(array[5,6,15,16]),
          'assignments', case n
            when 1 then jsonb_build_array(
              jsonb_build_object('id','mhl02-01-lead','role','original','participantIds',jsonb_build_array('sihyeon','young-eun'),'scope','line')
            )
            when 2 then jsonb_build_array(
              jsonb_build_object('id','mhl02-02-lead','role','original','participantIds',jsonb_build_array('sihyeon','young-eun'),'scope','line'),
              jsonb_build_object('id','mhl02-02-extra','role','additional','participantIds',jsonb_build_array('byeongchan','dohee'),'scope','anchor','anchorText','소중한 기억들')
            )
            when 3 then jsonb_build_array(
              jsonb_build_object('id','mhl02-03-lead','role','original','participantIds',jsonb_build_array('byeongchan','dohee'),'scope','line')
            )
            when 4 then jsonb_build_array(
              jsonb_build_object('id','mhl02-04-lead','role','original','participantIds',jsonb_build_array('byeongchan','dohee'),'scope','line'),
              jsonb_build_object('id','mhl02-04-extra','role','additional','participantIds',jsonb_build_array('sihyeon','young-eun'),'scope','anchor','anchorText','잊을 수 없는 Memories')
            )
            when 7 then jsonb_build_array(
              jsonb_build_object('id','mhl02-07-lead','role','original','participantIds',jsonb_build_array('sihyeon'),'scope','line')
            )
            when 8 then jsonb_build_array(
              jsonb_build_object('id','mhl02-08-lead','role','original','participantIds',jsonb_build_array('sihyeon'),'scope','line'),
              jsonb_build_object('id','mhl02-08-extra','role','additional','participantIds',jsonb_build_array('young-eun'),'scope','line','note','전체 줄로 해석한 초안')
            )
            when 9 then jsonb_build_array(
              jsonb_build_object('id','mhl02-09-lead','role','original','participantIds',jsonb_build_array('young-eun'),'scope','line')
            )
            when 10 then jsonb_build_array(
              jsonb_build_object('id','mhl02-10-lead','role','original','participantIds',jsonb_build_array('young-eun'),'scope','line'),
              jsonb_build_object('id','mhl02-10-extra','role','additional','participantIds',jsonb_build_array('sihyeon'),'scope','anchor','anchorText','너무 아름다워')
            )
            when 11 then jsonb_build_array(
              jsonb_build_object('id','mhl02-11-lead','role','original','participantIds',jsonb_build_array('byeongchan','dohee'),'scope','line')
            )
            when 12 then jsonb_build_array(
              jsonb_build_object('id','mhl02-12-lead','role','original','participantIds',jsonb_build_array('byeongchan'),'scope','line'),
              jsonb_build_object('id','mhl02-12-extra','role','additional','participantIds',jsonb_build_array('dohee'),'scope','anchor','anchorText','너만 있으면 돼')
            )
            when 13 then jsonb_build_array(
              jsonb_build_object('id','mhl02-13-lead','role','original','participantIds',jsonb_build_array('byeongchan','dohee'),'scope','line')
            )
            when 14 then jsonb_build_array(
              jsonb_build_object('id','mhl02-14-lead','role','original','participantIds',jsonb_build_array('byeongchan','dohee'),'scope','line'),
              jsonb_build_object('id','mhl02-14-extra','role','additional','participantIds',jsonb_build_array('young-eun'),'scope','line','note','전체 줄로 해석한 초안')
            )
            when 17 then jsonb_build_array(
              jsonb_build_object('id','mhl02-17-lead','role','original','participantIds',jsonb_build_array('byeongchan'),'scope','line')
            )
            when 18 then jsonb_build_array(
              jsonb_build_object('id','mhl02-18-lead','role','original','participantIds',jsonb_build_array('byeongchan'),'scope','line'),
              jsonb_build_object('id','mhl02-18-extra','role','additional','participantIds',jsonb_build_array('dohee'),'scope','line','note','전체 줄로 해석한 초안')
            )
            when 19 then jsonb_build_array(
              jsonb_build_object('id','mhl02-19-lead','role','original','participantIds',jsonb_build_array('dohee'),'scope','line')
            )
            when 20 then jsonb_build_array(
              jsonb_build_object('id','mhl02-20-lead','role','original','participantIds',jsonb_build_array('dohee'),'scope','line'),
              jsonb_build_object('id','mhl02-20-extra','role','additional','participantIds',jsonb_build_array('byeongchan'),'scope','anchor','anchorText','너만을 사랑해')
            )
            when 21 then jsonb_build_array(
              jsonb_build_object('id','mhl02-21-lead','role','original','participantIds',jsonb_build_array('sihyeon','young-eun'),'scope','line')
            )
            when 22 then jsonb_build_array(
              jsonb_build_object('id','mhl02-22-lead','role','original','participantIds',jsonb_build_array('sihyeon'),'scope','line'),
              jsonb_build_object('id','mhl02-22-extra','role','additional','participantIds',jsonb_build_array('young-eun'),'scope','anchor','anchorText','너만 있으면 돼')
            )
            when 23 then jsonb_build_array(
              jsonb_build_object('id','mhl02-23-lead','role','original','participantIds',jsonb_build_array('sihyeon','young-eun'),'scope','line')
            )
            else '[]'::jsonb
          end,
          'styles', '[]'::jsonb
        ) order by n
      )
      from generate_series(1,32) as line_numbers(n)
    )
  ) as data
)
insert into public.one_song_projects(round_number,song_title,data)
select 2,'Must Have Love',seed_data.data
from seed_data
where not exists (
  select 1 from public.one_song_projects
  where round_number=2 and song_title='Must Have Love'
);

commit;
