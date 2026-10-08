begin;

-- New formal registrations start a three-hour review target. Existing reviews are preserved.
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
  select array_agg(id order by id) into operator_ids from public.members where role='운영진' and is_active is true;
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
$$;
revoke all on function public.vom_ot_finalize_upload(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.vom_ot_finalize_upload(uuid,uuid,text,text,text,text) to service_role;


-- Older registration links were embedded in public manifests. Rotate their capability
-- while preserving invite IDs and already subscribed devices. Admins can fetch the new link.
update public.vom_push_invites
set invite_token=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','')
where is_active is true and char_length(invite_token)<64;

-- Private delivery records prevent successful devices being retried when another fails.
create table public.ot_operator_push_deliveries (
  review_id bigint not null references public.ot_reviews(id) on delete cascade,
  subscription_id bigint not null references public.vom_push_subscriptions(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key(review_id,subscription_id)
);
alter table public.ot_operator_push_deliveries enable row level security;
revoke all on public.ot_operator_push_deliveries from public,anon,authenticated;
grant all on public.ot_operator_push_deliveries to service_role;
create index ot_operator_push_deliveries_subscription_idx on public.ot_operator_push_deliveries(subscription_id);

commit;
