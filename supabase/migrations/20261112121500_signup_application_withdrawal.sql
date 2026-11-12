create or replace function public.vom_ot_withdraw_review(
  p_review_id bigint,
  p_actor_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  review public.ot_reviews%rowtype;
  now_at timestamptz := clock_timestamp();
begin
  if p_actor_id is null then raise exception 'withdraw_actor_required'; end if;

  select * into review
  from public.ot_reviews
  where id = p_review_id
  for update;

  if not found then raise exception 'review_not_found'; end if;
  if review.status <> 'IN_REVIEW' or review.completed_at is not null then
    raise exception 'review_already_resolved';
  end if;
  if not exists (
    select 1
    from public.ot_room_invites i
    where i.review_id = p_review_id
      and i.applicant_user_id = p_actor_id
      and i.revoked_at is null
  ) then
    raise exception 'withdraw_actor_mismatch';
  end if;

  update public.ot_reviews
  set status = 'DISCARDED',
      resolved_at = now_at,
      updated_at = now_at,
      discarded_at = now_at,
      discarded_by = p_actor_id,
      discard_reason = '신청자 철회'
  where id = p_review_id;

  insert into public.ot_review_discard_log(
    review_id, actor_user_id, actor_member_id, actor_name, reason, created_at
  ) values (
    p_review_id, p_actor_id, null, '신청자', '신청자 철회', now_at
  );

  update public.ot_room_invites
  set revoked_at = now_at
  where review_id = p_review_id
    and applicant_user_id = p_actor_id
    and revoked_at is null;

  return jsonb_build_object('review_id', p_review_id, 'status', 'DISCARDED', 'withdrawn_at', now_at);
end;
$function$;

revoke all on function public.vom_ot_withdraw_review(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.vom_ot_withdraw_review(bigint, uuid)
  to service_role;
