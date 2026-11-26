begin;

-- Refresh only the untouched Must Have Love #02 starter record. If lyrics have
-- already been entered, leave the project intact for the editor to preserve.
with replacement as (
  select jsonb_agg(
    jsonb_build_object(
      'id','must-have-love-02-' || lpad(n::text,2,'0'),
      'sectionTitle',case
        when n between 5 and 6 then '후렴'
        when n between 15 and 16 then '후렴'
        when n between 25 and 29 then '후렴'
        when n between 30 and 33 then '아웃트로'
        else ''
      end,
      'lyrics',case
        when n=27 then '네가 있기에'
        when n=32 then 'This season is the time'
        when n=33 then 'For you'
        else ''
      end,
      'chorus',n=any(array[5,6,15,16]),
      'leadDisplay',case when n=any(array[5,6,15,16,31,32]) then 'high-low' when n=any(array[25,26]) then 'hidden' else 'names' end,
      'registerMarker',case n
        when 14 then jsonb_build_object('participantId','sihyeon','register','low')
        when 24 then jsonb_build_object('participantId','young-eun','register','high')
        when 25 then jsonb_build_object('participantId','byeongchan','register','low')
        when 26 then jsonb_build_object('participantId','byeongchan','register','low')
        when 27 then jsonb_build_object('participantId','sihyeon','register','low')
        when 28 then jsonb_build_object('participantId','sihyeon','register','low')
        else null
      end,
      'assignments',case n
        when 1 then jsonb_build_array(
          jsonb_build_object('id','mhl02-01-lead','role','together','participantIds',jsonb_build_array('sihyeon','byeongchan'),'scope','line'),
          jsonb_build_object('id','mhl02-01-extra','role','additional','participantIds',jsonb_build_array('dohee','young-eun'),'scope','anchor','anchorText','행복했었던')
        )
        when 2 then jsonb_build_array(
          jsonb_build_object('id','mhl02-02-lead','role','together','participantIds',jsonb_build_array('sihyeon','byeongchan'),'scope','line'),
          jsonb_build_object('id','mhl02-02-extra','role','additional','participantIds',jsonb_build_array('dohee','young-eun'),'scope','anchor','anchorText','소중한 기억들')
        )
        when 3 then jsonb_build_array(
          jsonb_build_object('id','mhl02-03-lead','role','together','participantIds',jsonb_build_array('sihyeon','byeongchan'),'scope','line')
        )
        when 4 then jsonb_build_array(
          jsonb_build_object('id','mhl02-04-lead','role','together','participantIds',jsonb_build_array('sihyeon','byeongchan'),'scope','line'),
          jsonb_build_object('id','mhl02-04-extra','role','additional','participantIds',jsonb_build_array('dohee','young-eun'),'scope','anchor','anchorText','잊을 수 없는 Memories')
        )
        when 5 then jsonb_build_array(jsonb_build_object('id','mhl02-05-lead','role','together','participantIds',jsonb_build_array('sihyeon','byeongchan'),'scope','line'))
        when 6 then jsonb_build_array(jsonb_build_object('id','mhl02-06-lead','role','together','participantIds',jsonb_build_array('sihyeon','byeongchan'),'scope','line'))
        when 7 then jsonb_build_array(jsonb_build_object('id','mhl02-07-lead','role','original','participantIds',jsonb_build_array('sihyeon'),'scope','line'))
        when 8 then jsonb_build_array(
          jsonb_build_object('id','mhl02-08-lead','role','original','participantIds',jsonb_build_array('sihyeon'),'scope','line'),
          jsonb_build_object('id','mhl02-08-extra','role','additional','participantIds',jsonb_build_array('young-eun'),'scope','line','note','전체 줄로 해석한 초안')
        )
        when 9 then jsonb_build_array(jsonb_build_object('id','mhl02-09-lead','role','original','participantIds',jsonb_build_array('young-eun'),'scope','line'))
        when 10 then jsonb_build_array(
          jsonb_build_object('id','mhl02-10-lead','role','original','participantIds',jsonb_build_array('young-eun'),'scope','line'),
          jsonb_build_object('id','mhl02-10-extra','role','additional','participantIds',jsonb_build_array('sihyeon'),'scope','anchor','anchorText','너무 아름다워')
        )
        when 11 then jsonb_build_array(jsonb_build_object('id','mhl02-11-lead','role','together','participantIds',jsonb_build_array('byeongchan','dohee'),'scope','line'))
        when 12 then jsonb_build_array(
          jsonb_build_object('id','mhl02-12-lead','role','original','participantIds',jsonb_build_array('byeongchan'),'scope','line'),
          jsonb_build_object('id','mhl02-12-extra','role','additional','participantIds',jsonb_build_array('dohee'),'scope','anchor','anchorText','너만 있으면 돼')
        )
        when 13 then jsonb_build_array(jsonb_build_object('id','mhl02-13-lead','role','together','participantIds',jsonb_build_array('byeongchan','dohee'),'scope','line'))
        when 14 then jsonb_build_array(
          jsonb_build_object('id','mhl02-14-lead','role','together','participantIds',jsonb_build_array('byeongchan','dohee'),'scope','line'),
          jsonb_build_object('id','mhl02-14-extra','role','additional','participantIds',jsonb_build_array('young-eun'),'scope','line','note','전체 줄로 해석한 초안')
        )
        when 15 then jsonb_build_array(jsonb_build_object('id','mhl02-15-lead','role','together','participantIds',jsonb_build_array('sihyeon','byeongchan'),'scope','line'))
        when 16 then jsonb_build_array(jsonb_build_object('id','mhl02-16-lead','role','together','participantIds',jsonb_build_array('sihyeon','byeongchan'),'scope','line'))
        when 17 then jsonb_build_array(jsonb_build_object('id','mhl02-17-lead','role','original','participantIds',jsonb_build_array('byeongchan'),'scope','line'))
        when 18 then jsonb_build_array(
          jsonb_build_object('id','mhl02-18-lead','role','original','participantIds',jsonb_build_array('byeongchan'),'scope','line'),
          jsonb_build_object('id','mhl02-18-extra','role','additional','participantIds',jsonb_build_array('dohee'),'scope','line','note','전체 줄로 해석한 초안')
        )
        when 19 then jsonb_build_array(jsonb_build_object('id','mhl02-19-lead','role','original','participantIds',jsonb_build_array('dohee'),'scope','line'))
        when 20 then jsonb_build_array(jsonb_build_object('id','mhl02-20-lead','role','together','participantIds',jsonb_build_array('dohee','byeongchan'),'scope','anchor','anchorText','너만을 사랑해'))
        when 21 then jsonb_build_array(jsonb_build_object('id','mhl02-21-lead','role','together','participantIds',jsonb_build_array('sihyeon','young-eun'),'scope','line'))
        when 22 then jsonb_build_array(
          jsonb_build_object('id','mhl02-22-lead','role','original','participantIds',jsonb_build_array('sihyeon'),'scope','line'),
          jsonb_build_object('id','mhl02-22-extra','role','additional','participantIds',jsonb_build_array('young-eun'),'scope','anchor','anchorText','너만 있으면 돼')
        )
        when 23 then jsonb_build_array(jsonb_build_object('id','mhl02-23-lead','role','together','participantIds',jsonb_build_array('sihyeon','young-eun'),'scope','line'))
        when 25 then jsonb_build_array(jsonb_build_object('id','mhl02-25-lead','role','together','participantIds',jsonb_build_array('sihyeon','young-eun','byeongchan','dohee'),'scope','line'))
        when 26 then jsonb_build_array(jsonb_build_object('id','mhl02-26-lead','role','together','participantIds',jsonb_build_array('sihyeon','young-eun','byeongchan','dohee'),'scope','line'))
        when 28 then jsonb_build_array(jsonb_build_object('id','mhl02-28-lead','role','original','participantIds',jsonb_build_array('byeongchan'),'scope','anchor','anchorText','잊을 수 없는'))
        when 29 then jsonb_build_array(jsonb_build_object('id','mhl02-29-lead','role','original','participantIds',jsonb_build_array('young-eun'),'scope','anchor','anchorText','잊을 수 없는'))
        when 30 then jsonb_build_array(jsonb_build_object('id','mhl02-30-lead','role','original','participantIds',jsonb_build_array('sihyeon'),'scope','line'))
        when 31 then jsonb_build_array(jsonb_build_object('id','mhl02-31-lead','role','together','participantIds',jsonb_build_array('sihyeon','byeongchan'),'scope','line'))
        when 32 then jsonb_build_array(jsonb_build_object('id','mhl02-32-lead','role','together','participantIds',jsonb_build_array('sihyeon','byeongchan'),'scope','line'))
        else '[]'::jsonb
      end,
      'overlaps',case n
        when 25 then jsonb_build_array(jsonb_build_object('id','mhl02-25-overlap','text','행복했었더어어언~','participantIds',jsonb_build_array('dohee'),'placement','above','anchorText','','foregroundColor','#c83f58','backgroundColor',''))
        when 27 then jsonb_build_array(jsonb_build_object('id','mhl02-27-overlap','text','후우우~~','participantIds',jsonb_build_array('dohee'),'placement','after','anchorText','네가 있기에','foregroundColor','#c83f58','backgroundColor',''))
        else '[]'::jsonb
      end,
      'styles','[]'::jsonb
    ) order by n
  ) as lines
  from generate_series(1,33) as line_numbers(n)
)
update public.one_song_projects as project
set data=jsonb_set(
      jsonb_set(project.data,'{version}','2'::jsonb,true),
      '{lines}',replacement.lines,true
    ),
    updated_at=now()
from replacement
where project.round_number=2
  and project.song_title='Must Have Love'
  and jsonb_typeof(project.data->'lines')='array'
  and not exists (
    select 1
    from jsonb_array_elements(project.data->'lines') as old_line(value)
    where btrim(coalesce(old_line.value->>'lyrics',''))<>''
  );

commit;
