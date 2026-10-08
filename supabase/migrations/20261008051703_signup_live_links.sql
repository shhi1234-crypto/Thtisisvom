begin;

-- Reuse existing private reviews and reservations for external live links.
alter table public.ot_signup_reservations add column media_source text not null default 'FILE';
alter table public.ot_signup_reservations add column media_url text;
alter table public.ot_signup_reservations alter column media_path drop not null;
alter table public.ot_signup_reservations add constraint ot_signup_reservations_media_location_check check (
  (media_source='FILE' and media_path is not null and media_url is null) or
  (media_source='LINK' and media_path is null and media_url is not null and char_length(media_url)<=2048 and media_url ~ '^https://[^[:space:]]+$')
);

create function public.vom_ot_finalize_link(p_invite_id uuid,p_claim_id uuid,p_media_url text)
returns jsonb language plpgsql security invoker set search_path='' as $$
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
  select array_agg(id order by id) into operator_ids from public.members where role='운영진' and is_active is true;
  if coalesce(cardinality(operator_ids),0)=0 then raise exception 'no_operators'; end if;
  insert into public.ot_reviews(candidate_name,somoim_nickname,room_label,video_source,video_url,
    status,created_at,due_at,eligible_operator_ids,required_majority,created_by,media_kind)
    values(application.candidate_name,application.somoim_nickname,'OT Room','LINK',p_media_url,
      'IN_REVIEW',registered_at,registered_at+interval '3 hours',operator_ids,cardinality(operator_ids)/2+1,invitation.issued_by,'VIDEO')
    returning id into new_review_id;
  update public.ot_room_invites set review_id=new_review_id,somoim_nickname=application.somoim_nickname,
    upload_claim_id=null,upload_claimed_at=null where id=p_invite_id;
  return jsonb_build_object('id',new_review_id,'submitted_at',registered_at,'check_at',registered_at+interval '3 hours');
end;$$;
revoke all on function public.vom_ot_finalize_link(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.vom_ot_finalize_link(uuid,uuid,text) to service_role;

create function public.vom_ot_reserve_link(p_invite_id uuid,p_claim_id uuid,p_media_url text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare invitation public.ot_room_invites%rowtype; scheduled timestamptz;
begin
  select * into invitation from public.ot_room_invites where id=p_invite_id for update;
  if not found or invitation.revoked_at is not null or invitation.expires_at<=clock_timestamp()
    or invitation.review_id is not null or invitation.signup_source is distinct from 'PUBLIC'
    or invitation.applicant_user_id is null or p_claim_id is null
    or invitation.upload_claim_id is distinct from p_claim_id then raise exception 'invalid_link_claim'; end if;
  if not exists(select 1 from public.ot_room_applicants where invite_id=p_invite_id and form_version>=2 and profile_photo_path is not null) then raise exception 'photo_required'; end if;
  if p_media_url is null or char_length(p_media_url)>2048 or p_media_url !~ '^https://[^[:space:]]+$' then raise exception 'invalid_media_link'; end if;
  scheduled:=(((clock_timestamp() at time zone 'Asia/Seoul')::date+1)+time '09:00') at time zone 'Asia/Seoul';
  insert into public.ot_signup_reservations(invite_id,claim_id,media_source,media_url,media_path,file_name,scheduled_at,next_attempt_at)
    values(p_invite_id,p_claim_id,'LINK',p_media_url,null,'라이브 링크',scheduled,scheduled);
  return jsonb_build_object('scheduled_at',scheduled);
end;$$;
revoke all on function public.vom_ot_reserve_link(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.vom_ot_reserve_link(uuid,uuid,text) to service_role;

commit;
