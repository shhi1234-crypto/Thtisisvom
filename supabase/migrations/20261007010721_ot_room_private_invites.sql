-- Additive OT Room migration. No existing member / event / setlist policies change.
create table public.ot_room_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  somoim_nickname text check (somoim_nickname is null or char_length(somoim_nickname) between 1 and 80),
  issued_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  revoked_at timestamptz,
  review_id bigint unique references public.ot_reviews(id),
  upload_claim_id uuid,
  upload_claimed_at timestamptz,
  check ((upload_claim_id is null) = (upload_claimed_at is null))
);
alter table public.ot_room_invites enable row level security;
revoke all on public.ot_room_invites from public, anon, authenticated;
grant all on public.ot_room_invites to service_role;

-- Explicit OT access prevents the legacy public "0000" setup flow from turning
-- a newly claimed operator profile into permission to read applicants' videos.
create table public.ot_room_operator_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  member_id bigint not null unique references public.members(id),
  granted_by uuid references auth.users(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.ot_room_operator_access enable row level security;
revoke all on public.ot_room_operator_access from public,anon,authenticated;
grant all on public.ot_room_operator_access to service_role;
-- Preserve already linked operators, skip ambiguous links, and never auto-grant
-- access to accounts created after this migration. Admins retain their own access.
insert into public.ot_room_operator_access(user_id,member_id,granted_by)
  select m.auth_user_id,m.id,(select a.user_id from public.admins a order by a.created_at limit 1)
  from public.members m where m.role='운영진' and m.is_active is true and m.auth_user_id is not null
  and not exists(select 1 from public.members other where other.auth_user_id=m.auth_user_id and other.id<>m.id);

alter table public.ot_reviews
  add column operator_notified_at timestamptz,
  add column notification_attempts integer not null default 0,
  add column notification_next_attempt_at timestamptz not null default now(),
  add column notification_claimed_at timestamptz,
  add column completed_member_id bigint references public.members(id),
  add column completed_at timestamptz,
  add column completed_by uuid references auth.users(id);
alter table public.ot_review_votes add column recorded_by uuid references auth.users(id);
create index ot_reviews_notification_queue_idx on public.ot_reviews(notification_next_attempt_at)
  where operator_notified_at is null;
create index ot_reviews_pending_due_idx on public.ot_reviews(due_at) where status = 'IN_REVIEW';

-- A caller with a member JWT or publishable key cannot execute these RPCs.
-- SECURITY INVOKER is intentional: only the server's service_role can call them.
create function public.vom_ot_finalize_upload(
  p_invite_id uuid, p_claim_id uuid, p_candidate_name text,
  p_somoim_nickname text, p_file_path text, p_file_name text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  invitation public.ot_room_invites%rowtype;
  operator_ids bigint[];
  new_review_id bigint;
  registration_time time;
begin
  select * into invitation from public.ot_room_invites where id=p_invite_id for update;
  if not found or invitation.revoked_at is not null or invitation.expires_at <= clock_timestamp() then
    raise exception 'invalid_invite';
  end if;
  if invitation.review_id is not null then raise exception 'already_submitted'; end if;
  if p_claim_id is null or invitation.upload_claim_id is distinct from p_claim_id then raise exception 'invalid_claim'; end if;
  registration_time := (clock_timestamp() at time zone 'Asia/Seoul')::time;
  if registration_time < time '09:00' or registration_time >= time '18:00' then raise exception 'room_closed'; end if;
  if char_length(btrim(p_candidate_name)) not between 1 and 60 or char_length(btrim(p_somoim_nickname)) not between 1 and 80 then
    raise exception 'invalid_candidate';
  end if;
  if p_file_path !~ ('^reviews/' || p_invite_id::text || '/' || p_claim_id::text || '\.(mp4|mov|webm|3gp)$') then raise exception 'invalid_file_path'; end if;
  if not exists (
    select 1 from storage.objects where bucket_id='ot-review-videos' and name=p_file_path
      and (metadata->>'size')::bigint between 1 and 52428800
      and metadata->>'mimetype' in ('video/mp4','video/quicktime','video/webm','video/3gpp')
  ) then raise exception 'video_missing'; end if;
  select array_agg(id order by id) into operator_ids from public.members where role='운영진' and is_active is true;
  if coalesce(cardinality(operator_ids),0)=0 then raise exception 'no_operators'; end if;
  insert into public.ot_reviews (
    candidate_name,somoim_nickname,room_label,video_source,video_file_path,video_file_name,
    status,due_at,eligible_operator_ids,required_majority,created_by
  ) values (
    btrim(p_candidate_name),btrim(p_somoim_nickname),'OT Room','FILE',p_file_path,p_file_name,
    'IN_REVIEW',clock_timestamp()+interval '120 minutes',operator_ids,cardinality(operator_ids)/2+1,invitation.issued_by
  ) returning id into new_review_id;
  update public.ot_room_invites set review_id=new_review_id,
    somoim_nickname=btrim(p_somoim_nickname),upload_claim_id=null,upload_claimed_at=null where id=p_invite_id;
  return jsonb_build_object('id',new_review_id);
end;
$$;
revoke all on function public.vom_ot_finalize_upload(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.vom_ot_finalize_upload(uuid,uuid,text,text,text,text) to service_role;

create function public.vom_ot_record_vote(p_review_id bigint,p_member_id bigint,p_decision text,p_actor_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  review public.ot_reviews%rowtype;
  approvals integer;
  rejections integer;
  new_status text := 'IN_REVIEW';
begin
  if p_decision not in ('APPROVE','REJECT','HOLD') then raise exception 'invalid_decision'; end if;
  if not exists(select 1 from public.members where id=p_member_id and role='운영진' and is_active is true) then raise exception 'operator_required'; end if;
  if not exists(select 1 from public.admins where user_id=p_actor_id) and not exists (
    select 1 from public.members where id=p_member_id and auth_user_id=p_actor_id and role='운영진' and is_active is true
  ) then raise exception 'voter_identity_mismatch'; end if;
  if not exists(select 1 from public.admins where user_id=p_actor_id) and not exists (
    select 1 from public.ot_room_operator_access where user_id=p_actor_id and member_id=p_member_id and revoked_at is null
  ) then raise exception 'ot_access_required'; end if;
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
$$;
revoke all on function public.vom_ot_record_vote(bigint,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.vom_ot_record_vote(bigint,bigint,text,uuid) to service_role;

-- Keep the bucket private. Public applicants and ordinary members have no Storage policy.
-- Admins' existing policy is retained to avoid disrupting prior administrator workflows.
do $$ begin
  if not exists(select 1 from storage.buckets where id='ot-review-videos' and public is false) then
    raise exception 'OT video bucket must already exist and be private';
  end if;
end; $$;
