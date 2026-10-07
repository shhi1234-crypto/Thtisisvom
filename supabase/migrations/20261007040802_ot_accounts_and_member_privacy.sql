-- Applicant accounts are separate from approved members. Passwords stay in Auth.
alter table public.ot_room_invites
  add column applicant_user_id uuid unique references auth.users(id),
  add column account_claim_id uuid,
  add column account_claimed_at timestamptz,
  add check ((account_claim_id is null) = (account_claimed_at is null));

create table public.ot_room_applicants (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  invite_id uuid not null unique references public.ot_room_invites(id),
  login_name text not null unique check(login_name ~ '^[a-z0-9][a-z0-9_.-]{3,29}$'),
  candidate_name text not null check(char_length(candidate_name) between 1 and 60),
  somoim_nickname text not null check(char_length(somoim_nickname) between 1 and 80),
  phone text check(phone is null or char_length(phone)<=30),
  birth_date date,
  region text check(region is null or char_length(region)<=80),
  gender text check(gender is null or char_length(gender)<=20),
  member_id bigint unique references public.members(id),
  privacy_consent_version text not null default '2026-10-07',
  privacy_consented_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.ot_room_applicants enable row level security;
revoke all on public.ot_room_applicants from public,anon,authenticated;
grant select on public.ot_room_applicants to authenticated;
grant all on public.ot_room_applicants to service_role;
create policy "applicant can read own application" on public.ot_room_applicants
  for select to authenticated using(auth_user_id=(select auth.uid()));

create function public.vom_ot_bind_account(p_invite_id uuid,p_claim_id uuid,p_user_id uuid,p_profile jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare invitation public.ot_room_invites%rowtype;
begin
  select * into invitation from public.ot_room_invites where id=p_invite_id for update;
  if not found or invitation.revoked_at is not null or invitation.expires_at<=clock_timestamp()
    or invitation.review_id is not null or invitation.applicant_user_id is not null
    or invitation.account_claim_id is distinct from p_claim_id or p_claim_id is null then
    raise exception 'invalid_account_claim';
  end if;
  insert into public.ot_room_applicants(auth_user_id,invite_id,login_name,candidate_name,somoim_nickname,phone,birth_date,region,gender)
  values(p_user_id,p_invite_id,p_profile->>'login_name',p_profile->>'candidate_name',p_profile->>'somoim_nickname',
    nullif(p_profile->>'phone',''),nullif(p_profile->>'birth_date','')::date,nullif(p_profile->>'region',''),nullif(p_profile->>'gender',''));
  update public.ot_room_invites set applicant_user_id=p_user_id,somoim_nickname=p_profile->>'somoim_nickname',
    account_claim_id=null,account_claimed_at=null where id=p_invite_id;
end; $$;
revoke all on function public.vom_ot_bind_account(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.vom_ot_bind_account(uuid,uuid,uuid,jsonb) to service_role;

create unique index members_auth_user_unique on public.members(auth_user_id) where auth_user_id is not null;
-- Existing imports assigned IDs explicitly. Advance, never rewind, the identity.
select setval(pg_get_serial_sequence('public.members','id'),
  greatest(coalesce((select max(id) from public.members),1),
    (select last_value from public.members_id_seq)),true);

create function private.vom_ot_approve_member() returns trigger
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
    insert into public.members(name,nickname,role,is_active,auth_user_id,joined_at,join_order)
    values(display_name,application.somoim_nickname,'모임원',true,application.auth_user_id,
      (clock_timestamp() at time zone 'Asia/Seoul')::date,(select coalesce(max(join_order),0)+1 from public.members))
    returning id into member_key;
  end if;
  insert into public.member_account_settings(member_id,must_change_password,password_changed_at)
    values(member_key,false,clock_timestamp()) on conflict(member_id) do nothing;
  update public.ot_room_applicants set member_id=member_key where auth_user_id=application.auth_user_id;
  new.completed_member_id:=member_key; new.completed_at:=clock_timestamp();
  return new;
end; $$;
revoke all on function private.vom_ot_approve_member() from public,anon,authenticated;
create trigger vom_ot_approve_member before update of status on public.ot_reviews
  for each row when(new.status='APPROVED') execute function private.vom_ot_approve_member();

-- A private, one-use activation link replaces the shared 0000 setup/reset.
create table public.member_activation_invites (
  id uuid primary key default gen_random_uuid(),
  member_id bigint not null references public.members(id) on delete cascade,
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  issued_by uuid not null references auth.users(id),
  expires_at timestamptz not null default now()+interval '7 days',
  consumed_at timestamptz, revoked_at timestamptz,
  claim_id uuid,claimed_at timestamptz,
  check((claim_id is null)=(claimed_at is null))
);
alter table public.member_activation_invites enable row level security;
revoke all on public.member_activation_invites from public,anon,authenticated;
grant all on public.member_activation_invites to service_role;
create function public.vom_activate_member(p_invite_id uuid,p_claim_id uuid,p_user_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare invitation public.member_activation_invites%rowtype; existing_user uuid;
begin
  select * into invitation from public.member_activation_invites where id=p_invite_id for update;
  if not found or invitation.consumed_at is not null or invitation.revoked_at is not null
    or invitation.expires_at<=clock_timestamp() or invitation.claim_id is distinct from p_claim_id or p_claim_id is null
    then raise exception 'invalid_activation'; end if;
  select auth_user_id into existing_user from public.members where id=invitation.member_id and is_active is true for update;
  if not found or (existing_user is not null and existing_user<>p_user_id) then raise exception 'identity_changed'; end if;
  update public.members set auth_user_id=p_user_id where id=invitation.member_id;
  insert into public.member_account_settings(member_id,must_change_password,password_changed_at,password_hint)
    values(invitation.member_id,false,clock_timestamp(),null) on conflict(member_id) do update
      set must_change_password=false,password_changed_at=excluded.password_changed_at,password_hint=null;
  update public.member_activation_invites set consumed_at=clock_timestamp(),claim_id=null,claimed_at=null where id=p_invite_id;
end; $$;
revoke all on function public.vom_activate_member(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.vom_activate_member(uuid,uuid,uuid) to service_role;

create function private.vom_is_approved() returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.admins where user_id=(select auth.uid())) or exists(
    select 1 from public.members m where m.auth_user_id=(select auth.uid()) and m.is_active is true
      and not exists(select 1 from public.member_account_settings s where s.member_id=m.id and s.must_change_password is true)
  );
$$;
revoke all on function private.vom_is_approved() from public,anon;
grant usage on schema private to authenticated;
grant execute on function private.vom_is_approved() to authenticated;

-- Public performance screens need display names, never a member's personal data.
create view public.members_display with(security_barrier=true) as
  select id,name,nickname,profile_image_url,role,is_active,join_order from public.members;
grant select on public.members_display to anon,authenticated;

-- Public VOM LIVE/BUSKING promotion stays visible; internal OTHER schedules and
-- operator notes/IDs are never included in this projection.
create view public.events_public with(security_barrier=true) as
  select id,created_at,title,event_type,event_date,start_time,end_time,location,location_id,image_url,
    somoim_apply_enabled,somoim_apply_url from public.events where event_type in('VOM LIVE','BUSKING');
grant select on public.events_public to anon,authenticated;
