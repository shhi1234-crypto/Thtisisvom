-- Private durable reservations. Formal reviews are still created only from 09:00 to 18:00 KST.
create table public.ot_signup_reservations(
  invite_id uuid primary key references public.ot_room_invites(id) on delete cascade,
  claim_id uuid not null, media_path text not null, file_name text not null,
  scheduled_at timestamptz not null, next_attempt_at timestamptz not null,
  status text not null default 'WAITING' check(status in('WAITING','PROCESSING','COMPLETE','CANCELLED')),
  claimed_at timestamptz, completed_at timestamptz, created_at timestamptz not null default now()
);
alter table public.ot_signup_reservations enable row level security;
revoke all on public.ot_signup_reservations from public,anon,authenticated;
grant all on public.ot_signup_reservations to service_role;
create index ot_signup_reservations_due on public.ot_signup_reservations(scheduled_at,next_attempt_at) where status in('WAITING','PROCESSING');
create function public.vom_ot_reserve_upload(p_invite_id uuid,p_claim_id uuid,p_file_path text,p_file_name text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare invitation public.ot_room_invites%rowtype; scheduled timestamptz;
begin
  select * into invitation from public.ot_room_invites where id=p_invite_id for update;
  if not found or invitation.revoked_at is not null or invitation.expires_at<=clock_timestamp()
    or invitation.review_id is not null or invitation.signup_source is distinct from 'PUBLIC'
    or invitation.applicant_user_id is null or p_claim_id is null
    or invitation.upload_claim_id is distinct from p_claim_id then raise exception 'invalid_reservation'; end if;
  if not exists(select 1 from public.ot_room_applicants where invite_id=p_invite_id and form_version>=2 and profile_photo_path is not null) then raise exception 'photo_required'; end if;
  if p_file_path !~ ('^reviews/'||p_invite_id::text||'/'||p_claim_id::text||'\.(mp4|mov|webm|3gp|mp3|m4a|wav|aac|ogg|flac|aiff)$') then raise exception 'invalid_file_path'; end if;
  if not exists(select 1 from storage.objects where bucket_id='ot-review-videos' and name=p_file_path
    and (metadata->>'size')::bigint between 1 and 52428800
    and metadata->>'mimetype' in('video/mp4','video/quicktime','video/webm','video/3gpp','audio/mp4','audio/mpeg','audio/wav','audio/x-wav','audio/aac','audio/ogg','audio/flac','audio/webm','audio/aiff')) then raise exception 'video_missing'; end if;
  scheduled:=(((clock_timestamp() at time zone 'Asia/Seoul')::date+1)+time '09:00') at time zone 'Asia/Seoul';
  insert into public.ot_signup_reservations(invite_id,claim_id,media_path,file_name,scheduled_at,next_attempt_at)
    values(p_invite_id,p_claim_id,p_file_path,p_file_name,scheduled,scheduled);
  return jsonb_build_object('scheduled_at',scheduled);
end;$$;
revoke all on function public.vom_ot_reserve_upload(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.vom_ot_reserve_upload(uuid,uuid,text,text) to service_role;

-- Four-digit signup passwords share one server-side attempt budget across name and ID login.
create table public.vom_login_attempts(login_hash text primary key check(login_hash ~ '^[a-f0-9]{64}$'),window_start timestamptz not null,attempts integer not null);
alter table public.vom_login_attempts enable row level security;
revoke all on public.vom_login_attempts from public,anon,authenticated;
grant all on public.vom_login_attempts to service_role;
create function public.vom_claim_login_attempt(p_key text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare count integer;
begin
  insert into public.vom_login_attempts(login_hash,window_start,attempts) values(p_key,clock_timestamp(),1)
  on conflict(login_hash) do update set
    attempts=case when public.vom_login_attempts.window_start<=clock_timestamp()-interval '15 minutes' then 1 else public.vom_login_attempts.attempts+1 end,
    window_start=case when public.vom_login_attempts.window_start<=clock_timestamp()-interval '15 minutes' then clock_timestamp() else public.vom_login_attempts.window_start end
  where public.vom_login_attempts.attempts<5 or public.vom_login_attempts.window_start<=clock_timestamp()-interval '15 minutes'
  returning attempts into count;
  return found;
end;$$;
revoke all on function public.vom_claim_login_attempt(text) from public,anon,authenticated;
grant execute on function public.vom_claim_login_attempt(text) to service_role;
