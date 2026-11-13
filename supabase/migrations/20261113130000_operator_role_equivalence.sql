-- Treat the homepage roles "운영진" and "모임장" as one OT reviewer group.
-- Keep the stored title intact; role changes automatically update every pending quorum.

CREATE OR REPLACE FUNCTION public.vom_ot_finalize_link(p_invite_id uuid, p_claim_id uuid, p_media_url text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  invitation public.ot_room_invites%rowtype;
  application public.ot_room_applicants%rowtype;
  operator_ids bigint[];
  registered_at timestamptz;
  registration_time time;
  new_review_id bigint;
begin
  select * into invitation from public.ot_room_invites where id=p_invite_id for update;
  if not found or invitation.revoked_at is not null or invitation.expires_at<=clock_timestamp()
    or invitation.review_id is not null or invitation.signup_source is distinct from 'PUBLIC'
    or invitation.applicant_user_id is null or p_claim_id is null
    or invitation.upload_claim_id is distinct from p_claim_id then raise exception 'invalid_link_claim'; end if;
  select * into application from public.ot_room_applicants where invite_id=p_invite_id;
  if not found or application.form_version<2 or application.profile_photo_path is null then raise exception 'photo_required'; end if;
  if p_media_url is null or char_length(p_media_url)>2048 or p_media_url !~ '^https://[^[:space:]]+$' then raise exception 'invalid_media_link'; end if;
  registered_at:=clock_timestamp();
  registration_time:=(registered_at at time zone 'Asia/Seoul')::time;
  if registration_time<time '09:00' or registration_time>=time '18:00' then raise exception 'room_closed'; end if;
  select array_agg(id order by id) into operator_ids from public.members where role in ('운영진','모임장') and is_active is true and auth_user_id is not null;
  if coalesce(cardinality(operator_ids),0)=0 then raise exception 'no_operators'; end if;
  insert into public.ot_reviews(candidate_name,somoim_nickname,room_label,video_source,video_url,
    status,created_at,due_at,eligible_operator_ids,required_majority,created_by,media_kind)
    values(application.candidate_name,application.somoim_nickname,'OT Room','LINK',p_media_url,
      'IN_REVIEW',registered_at,registered_at+interval '3 hours',operator_ids,cardinality(operator_ids)/2+1,invitation.issued_by,'VIDEO')
    returning id into new_review_id;
  update public.ot_room_invites set review_id=new_review_id,somoim_nickname=application.somoim_nickname,
    upload_claim_id=null,upload_claimed_at=null where id=p_invite_id;
  return jsonb_build_object('id',new_review_id,'submitted_at',registered_at,'check_at',registered_at+interval '3 hours');
end;$function$;

CREATE OR REPLACE FUNCTION public.vom_ot_finalize_upload(p_invite_id uuid, p_claim_id uuid, p_candidate_name text, p_somoim_nickname text, p_file_path text, p_file_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  invitation public.ot_room_invites%rowtype;
  operator_ids bigint[];
  application public.ot_room_applicants%rowtype;
  media_mime text;
  new_review_id bigint;
  registration_time time;
  registered_at timestamptz;
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
  registered_at := clock_timestamp();
  registration_time := (registered_at at time zone 'Asia/Seoul')::time;
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
  select array_agg(id order by id) into operator_ids from public.members where role in ('운영진','모임장') and is_active is true and auth_user_id is not null;
  if coalesce(cardinality(operator_ids),0)=0 then raise exception 'no_operators'; end if;
  insert into public.ot_reviews (
    candidate_name,somoim_nickname,room_label,video_source,video_file_path,video_file_name,
    status,created_at,due_at,eligible_operator_ids,required_majority,created_by,media_kind
  ) values (
    btrim(p_candidate_name),btrim(p_somoim_nickname),'OT Room','FILE',p_file_path,p_file_name,
    'IN_REVIEW',registered_at,registered_at+interval '3 hours',operator_ids,cardinality(operator_ids)/2+1,invitation.issued_by,case when media_mime like 'audio/%' then 'AUDIO' else 'VIDEO' end
  ) returning id into new_review_id;
  update public.ot_room_invites set review_id=new_review_id,
    somoim_nickname=btrim(p_somoim_nickname),upload_claim_id=null,upload_claimed_at=null where id=p_invite_id;
  return jsonb_build_object('id',new_review_id,'submitted_at',registered_at,'check_at',registered_at+interval '3 hours');
end;
$function$;

CREATE OR REPLACE FUNCTION public.vom_ot_record_vote(p_review_id bigint, p_member_id bigint, p_decision text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  review public.ot_reviews%rowtype;
  approvals integer;
  rejections integer;
  new_status text := 'IN_REVIEW';
begin
  if p_decision not in ('APPROVE','REJECT','HOLD') then raise exception 'invalid_decision'; end if;
  if not exists(select 1 from public.members where id=p_member_id and role in ('운영진','모임장') and is_active is true) then raise exception 'operator_required'; end if;
  if not exists(select 1 from public.admins where user_id=p_actor_id) and not exists (
    select 1 from public.members where id=p_member_id and auth_user_id=p_actor_id and role in ('운영진','모임장') and is_active is true
  ) then raise exception 'voter_identity_mismatch'; end if;
  select * into review from public.ot_reviews where id=p_review_id for update;
  if not found then raise exception 'review_not_found'; end if;
  if review.status <> 'IN_REVIEW' then raise exception 'review_resolved'; end if;
  if not (p_member_id=any(review.eligible_operator_ids)) then raise exception 'ineligible_voter'; end if;
  insert into public.ot_review_votes(review_id,voter_member_id,decision,updated_at,recorded_by)
    values(p_review_id,p_member_id,p_decision,clock_timestamp(),p_actor_id)
    on conflict(review_id,voter_member_id) do update
      set decision=excluded.decision,updated_at=excluded.updated_at,recorded_by=excluded.recorded_by;
  select count(*) filter(where decision='APPROVE'),count(*) filter(where decision='REJECT')
    into approvals,rejections from public.ot_review_votes where review_id=p_review_id and voter_member_id=any(review.eligible_operator_ids);
  if approvals>=review.required_majority then new_status:='APPROVED';
  elsif rejections>=review.required_majority then new_status:='REJECTED'; end if;
  if new_status<>'IN_REVIEW' then
    update public.ot_reviews set status=new_status,resolved_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_review_id;
  end if;
  return jsonb_build_object('status',new_status,'approval_count',approvals,'rejection_count',rejections);
end;
$function$;

create or replace function private.vom_ot_sync_review_operators()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_operator_ids bigint[];
  v_required_majority smallint;
begin
  select coalesce(array_agg(id order by id), array[]::bigint[])
    into v_operator_ids
    from public.members
   where role in ('운영진','모임장')
     and is_active is true
     and auth_user_id is not null;

  v_required_majority := greatest(1, cardinality(v_operator_ids) / 2 + 1)::smallint;

  update public.ot_reviews
     set eligible_operator_ids = v_operator_ids,
         required_majority = v_required_majority,
         updated_at = clock_timestamp()
   where status = 'IN_REVIEW'
     and (eligible_operator_ids is distinct from v_operator_ids
          or required_majority is distinct from v_required_majority);

  return new;
end;
$function$;

create trigger vom_ot_sync_review_operators
after insert or update of role, is_active, auth_user_id on public.members
for each row
execute function private.vom_ot_sync_review_operators();

with current_operators as (
  select coalesce(array_agg(id order by id), array[]::bigint[]) as ids
    from public.members
   where role in ('운영진','모임장')
     and is_active is true
     and auth_user_id is not null
),
current_quorum as (
  select ids, greatest(1, cardinality(ids) / 2 + 1)::smallint as required_majority
    from current_operators
)
update public.ot_reviews as review
   set eligible_operator_ids = current_quorum.ids,
       required_majority = current_quorum.required_majority,
       updated_at = clock_timestamp()
  from current_quorum
 where review.status = 'IN_REVIEW'
   and (review.eligible_operator_ids is distinct from current_quorum.ids
        or review.required_majority is distinct from current_quorum.required_majority);
