-- Additive registration details; legacy applications keep their original form version.
alter table public.ot_room_applicants
  add column birth_year integer check(birth_year between 1900 and 2100),
  add column job text check(char_length(job) between 1 and 80),
  add column busking_experience numeric(7,2),
  add column busking_experience_unit text check(busking_experience_unit in('COUNT','YEARS')),
  add column form_version smallint not null default 1 check(form_version in(1,2)),
  add column profile_photo_path text,
  add column profile_photo_name text,
  add constraint applicant_experience_range check(busking_experience is null or
    (busking_experience>=0 and ((busking_experience_unit='COUNT' and busking_experience<=10000 and busking_experience=trunc(busking_experience))
      or (busking_experience_unit='YEARS' and busking_experience<=100)))),
  add constraint applicant_required_details check(form_version=1 or
    (birth_year is not null and job is not null and busking_experience is not null and busking_experience_unit is not null)),
  add constraint applicant_photo_pair check((profile_photo_path is null)=(profile_photo_name is null));
alter table public.ot_reviews add column media_kind text not null default 'VIDEO' check(media_kind in('VIDEO','AUDIO'));

-- The existing private bucket is reused. No public or member Storage access is added.
update storage.buckets set allowed_mime_types=array(select distinct mime from unnest(
  coalesce(allowed_mime_types,array[]::text[]) || array['audio/ogg','audio/flac','audio/webm','audio/aiff','image/jpeg','image/png','image/webp']) mime)
where id='ot-review-videos' and public is false;

create or replace function public.vom_ot_bind_account(p_invite_id uuid,p_claim_id uuid,p_user_id uuid,p_profile jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare invitation public.ot_room_invites%rowtype;
begin
  select * into invitation from public.ot_room_invites where id=p_invite_id for update;
  if not found or invitation.revoked_at is not null or invitation.expires_at<=clock_timestamp()
    or invitation.review_id is not null or invitation.applicant_user_id is not null
    or invitation.account_claim_id is distinct from p_claim_id or p_claim_id is null then
    raise exception 'invalid_account_claim';
  end if;
  insert into public.ot_room_applicants(auth_user_id,invite_id,login_name,candidate_name,somoim_nickname,phone,birth_date,region,gender,birth_year,job,busking_experience,busking_experience_unit,form_version)
  values(p_user_id,p_invite_id,p_profile->>'login_name',p_profile->>'candidate_name',p_profile->>'somoim_nickname',
    nullif(p_profile->>'phone',''),nullif(p_profile->>'birth_date','')::date,nullif(p_profile->>'region',''),nullif(p_profile->>'gender',''),nullif(p_profile->>'birth_year','')::integer,nullif(p_profile->>'job',''),
    nullif(p_profile->>'busking_experience','')::numeric,nullif(p_profile->>'busking_experience_unit',''),coalesce((p_profile->>'form_version')::integer,1));
  update public.ot_room_invites set applicant_user_id=p_user_id,somoim_nickname=p_profile->>'somoim_nickname',
    account_claim_id=null,account_claimed_at=null where id=p_invite_id;
end; $$;
revoke all on function public.vom_ot_bind_account(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.vom_ot_bind_account(uuid,uuid,uuid,jsonb) to service_role;


-- Commit a photo under the same exclusive lease used by recording submission.
create function public.vom_ot_finalize_photo(p_invite_id uuid,p_claim_id uuid,p_file_path text,p_file_name text)
returns void language plpgsql security invoker set search_path='' as $$
declare invitation public.ot_room_invites%rowtype;
begin
  select * into invitation from public.ot_room_invites where id=p_invite_id for update;
  if not found or invitation.revoked_at is not null or invitation.expires_at<=clock_timestamp()
    or invitation.review_id is not null or invitation.applicant_user_id is null
    or p_claim_id is null or invitation.upload_claim_id is distinct from p_claim_id then raise exception 'invalid_photo_claim'; end if;
  if p_file_path !~ ('^profiles/' || p_invite_id::text || '/' || p_claim_id::text || '\.(jpg|png|webp)$') then raise exception 'invalid_photo_path'; end if;
  if not exists(select 1 from storage.objects where bucket_id='ot-review-videos' and name=p_file_path
    and (metadata->>'size')::bigint between 1 and 5242880 and metadata->>'mimetype' in('image/jpeg','image/png','image/webp')) then raise exception 'photo_missing'; end if;
  update public.ot_room_applicants set profile_photo_path=p_file_path,profile_photo_name=p_file_name
    where auth_user_id=invitation.applicant_user_id and invite_id=p_invite_id and profile_photo_path is null;
  if not found then raise exception 'photo_already_registered'; end if;
  update public.ot_room_invites set upload_claim_id=null,upload_claimed_at=null where id=p_invite_id;
end; $$;
revoke all on function public.vom_ot_finalize_photo(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.vom_ot_finalize_photo(uuid,uuid,text,text) to service_role;

create or replace function public.vom_ot_finalize_upload(
  p_invite_id uuid, p_claim_id uuid, p_candidate_name text,
  p_somoim_nickname text, p_file_path text, p_file_name text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  invitation public.ot_room_invites%rowtype;
  operator_ids bigint[];
  application public.ot_room_applicants%rowtype;
  media_mime text;
  new_review_id bigint;
  registration_time time;
begin
  select * into invitation from public.ot_room_invites where id=p_invite_id for update;
  if not found or invitation.revoked_at is not null or invitation.expires_at <= clock_timestamp() then
    raise exception 'invalid_invite';
  end if;
  if invitation.review_id is not null then raise exception 'already_submitted'; end if;
  if p_claim_id is null or invitation.upload_claim_id is distinct from p_claim_id then raise exception 'invalid_claim'; end if;
  select * into application from public.ot_room_applicants where invite_id=p_invite_id;
  if found then
    if application.form_version>=2 and application.profile_photo_path is null then raise exception 'photo_required'; end if;
    p_candidate_name:=application.candidate_name; p_somoim_nickname:=application.somoim_nickname;
  end if;
  registration_time := (clock_timestamp() at time zone 'Asia/Seoul')::time;
  if registration_time < time '09:00' or registration_time >= time '18:00' then raise exception 'room_closed'; end if;
  if char_length(btrim(p_candidate_name)) not between 1 and 60 or char_length(btrim(p_somoim_nickname)) not between 1 and 80 then
    raise exception 'invalid_candidate';
  end if;
  if p_file_path !~ ('^reviews/' || p_invite_id::text || '/' || p_claim_id::text || '\.(mp4|mov|webm|3gp|mp3|m4a|wav|aac|ogg|flac|aiff)$') then raise exception 'invalid_file_path'; end if;
  if not exists (
    select 1 from storage.objects where bucket_id='ot-review-videos' and name=p_file_path
      and (metadata->>'size')::bigint between 1 and 52428800
      and metadata->>'mimetype' in ('video/mp4','video/quicktime','video/webm','video/3gpp','audio/mp4','audio/mpeg','audio/wav','audio/x-wav','audio/aac','audio/ogg','audio/flac','audio/webm','audio/aiff')
  ) then raise exception 'video_missing'; end if;
  select metadata->>'mimetype' into media_mime from storage.objects where bucket_id='ot-review-videos' and name=p_file_path;
  select array_agg(id order by id) into operator_ids from public.members where role='운영진' and is_active is true;
  if coalesce(cardinality(operator_ids),0)=0 then raise exception 'no_operators'; end if;
  insert into public.ot_reviews (
    candidate_name,somoim_nickname,room_label,video_source,video_file_path,video_file_name,
    status,due_at,eligible_operator_ids,required_majority,created_by,media_kind
  ) values (
    btrim(p_candidate_name),btrim(p_somoim_nickname),'OT Room','FILE',p_file_path,p_file_name,
    'IN_REVIEW',clock_timestamp()+interval '120 minutes',operator_ids,cardinality(operator_ids)/2+1,invitation.issued_by,case when media_mime like 'audio/%' then 'AUDIO' else 'VIDEO' end
  ) returning id into new_review_id;
  update public.ot_room_invites set review_id=new_review_id,
    somoim_nickname=btrim(p_somoim_nickname),upload_claim_id=null,upload_claimed_at=null where id=p_invite_id;
  return jsonb_build_object('id',new_review_id);
end;
$$;
revoke all on function public.vom_ot_finalize_upload(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.vom_ot_finalize_upload(uuid,uuid,text,text,text,text) to service_role;

create or replace function private.vom_ot_approve_member() returns trigger
language plpgsql security definer set search_path='' as $$
declare application public.ot_room_applicants%rowtype; member_key bigint; display_name text;
begin
  if new.status<>'APPROVED' or new.completed_member_id is not null then return new; end if;
  select a.* into application from public.ot_room_applicants a join public.ot_room_invites i on i.id=a.invite_id
    where i.review_id=new.id for update of a;
  if not found then return new; end if; -- Keep old administrator-created reviews compatible.
  perform pg_advisory_xact_lock(80477001);
  select id into member_key from public.members where auth_user_id=application.auth_user_id;
  if member_key is null then
    display_name:=application.somoim_nickname;
    if exists(select 1 from public.members where name=display_name) then
      display_name:=display_name || ' · ' || left(application.auth_user_id::text,8);
    end if;
    insert into public.members(name,nickname,role,is_active,auth_user_id,joined_at,join_order,job,phone,region,gender)
    values(display_name,application.somoim_nickname,'모임원',true,application.auth_user_id,
      (clock_timestamp() at time zone 'Asia/Seoul')::date,(select coalesce(max(join_order),0)+1 from public.members),application.job,application.phone,application.region,application.gender)
    returning id into member_key;
  end if;
  insert into public.member_account_settings(member_id,must_change_password,password_changed_at)
    values(member_key,false,clock_timestamp()) on conflict(member_id) do nothing;
  update public.ot_room_applicants set member_id=member_key where auth_user_id=application.auth_user_id;
  new.completed_member_id:=member_key; new.completed_at:=clock_timestamp();
  return new;
end; $$;
revoke all on function private.vom_ot_approve_member() from public,anon,authenticated;
