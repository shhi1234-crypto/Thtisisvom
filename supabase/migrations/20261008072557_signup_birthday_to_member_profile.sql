-- Copy the private applicant birthday when approval creates a member profile.
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
    insert into public.members(name,nickname,role,is_active,auth_user_id,joined_at,join_order,job,phone,region,gender,birth_date)
    values(display_name,application.somoim_nickname,'모임원',true,application.auth_user_id,
      (clock_timestamp() at time zone 'Asia/Seoul')::date,(select coalesce(max(join_order),0)+1 from public.members),application.job,application.phone,application.region,application.gender,application.birth_date)
    returning id into member_key;
  end if;
  insert into public.member_account_settings(member_id,must_change_password,password_changed_at)
    values(member_key,false,clock_timestamp()) on conflict(member_id) do nothing;
  update public.ot_room_applicants set member_id=member_key where auth_user_id=application.auth_user_id;
  new.completed_member_id:=member_key; new.completed_at:=clock_timestamp();
  return new;
end; $$;
revoke all on function private.vom_ot_approve_member() from public,anon,authenticated;
