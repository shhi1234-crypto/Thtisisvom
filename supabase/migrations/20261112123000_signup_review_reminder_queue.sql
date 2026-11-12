-- Queue one reminder 6 hours 30 minutes after receipt for each eligible operator who has not voted.
create table public.ot_review_reminder_outbox (
  id bigint generated always as identity primary key,
  review_id bigint not null references public.ot_reviews(id) on delete cascade,
  recipient_member_id bigint not null references public.members(id) on delete cascade,
  received_at timestamptz not null,
  due_at timestamptz not null,
  status text not null default 'QUEUED'
    check (status in ('QUEUED','SENDING','ACCEPTED','FAILED','SKIPPED')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  locked_at timestamptz,
  provider_message_id text,
  last_error text,
  accepted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (review_id, recipient_member_id)
);

alter table public.ot_review_reminder_outbox enable row level security;
revoke all on public.ot_review_reminder_outbox from public, anon, authenticated;
grant all on public.ot_review_reminder_outbox to service_role;

create index ot_review_reminder_outbox_queue_idx
  on public.ot_review_reminder_outbox(status, next_attempt_at, due_at, id);

comment on table public.ot_review_reminder_outbox is
  'Service-only queue for 6-hour-30-minute unresolved signup review reminders. Recipient contact data is read only at claim time and is not stored in this table.';

-- Serialize administrator withdrawals so two concurrent requests cannot remove the last two admins.
create or replace function public.vom_revoke_admin_if_not_last(
  p_user_id uuid
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_user_id is null then return false; end if;
  perform pg_advisory_xact_lock(781234567890::bigint);

  if not exists (
    select 1 from public.admins where user_id = p_user_id
  ) then
    return false;
  end if;
  if (select count(*) from public.admins) <= 1 then
    raise exception 'member_privacy_last_admin';
  end if;

  delete from public.admins where user_id = p_user_id;
  return true;
end;
$function$;

revoke all on function public.vom_revoke_admin_if_not_last(uuid)
  from public, anon, authenticated;
grant execute on function public.vom_revoke_admin_if_not_last(uuid)
  to service_role;

create or replace function public.vom_enqueue_signup_review_reminders(
  p_as_of timestamptz default clock_timestamp()
) returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  queued_count integer;
  as_of timestamptz := coalesce(p_as_of, clock_timestamp());
begin
  insert into public.ot_review_reminder_outbox(review_id, recipient_member_id, received_at, due_at)
  select distinct review.id, member.id,
    coalesce(reservation.created_at, review.created_at),
    coalesce(reservation.created_at, review.created_at) + interval '6 hours 30 minutes'
  from public.ot_reviews as review
  left join public.ot_room_invites as invitation on invitation.review_id = review.id
  left join public.ot_signup_reservations as reservation on reservation.invite_id = invitation.id
  join public.members as member
    on member.id = any(review.eligible_operator_ids)
  join public.member_message_preferences as preference
    on preference.member_id = member.id
   and preference.operator_alert_enabled is true
  where review.status = 'IN_REVIEW'
    and review.completed_at is null
    and coalesce(reservation.created_at, review.created_at) + interval '6 hours 30 minutes' <= as_of
    and member.role = '운영진'
    and member.is_active is true
    and regexp_replace(coalesce(member.phone, ''), '[^0-9]', '', 'g') ~ '^01[0-9]{8,9}$'
    and not exists (
      select 1
      from public.ot_review_votes as vote
      where vote.review_id = review.id
        and vote.voter_member_id = member.id
    )
  on conflict (review_id, recipient_member_id) do nothing;

  get diagnostics queued_count = row_count;
  return queued_count;
end;
$function$;

revoke all on function public.vom_enqueue_signup_review_reminders(timestamptz)
  from public, anon, authenticated;
grant execute on function public.vom_enqueue_signup_review_reminders(timestamptz)
  to service_role;

create or replace function public.vom_claim_signup_review_reminders(
  p_limit integer default 50,
  p_as_of timestamptz default clock_timestamp()
) returns table (
  outbox_id bigint,
  review_id bigint,
  recipient_member_id bigint,
  received_at timestamptz,
  reminder_due_at timestamptz,
  recipient_name text,
  recipient_phone text,
  review_url text,
  attempt_number integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  as_of timestamptz := coalesce(p_as_of, clock_timestamp());
begin
  perform public.vom_enqueue_signup_review_reminders(as_of);

  update public.ot_review_reminder_outbox as queued
  set status = 'SKIPPED',
      locked_at = null,
      last_error = 'review_resolved_or_operator_checked',
      updated_at = as_of
  where queued.status in ('QUEUED','FAILED')
    and not exists (
      select 1
      from public.ot_reviews as review
      left join public.ot_room_invites as invitation on invitation.review_id = review.id
      left join public.ot_signup_reservations as reservation on reservation.invite_id = invitation.id
      join public.members as member
        on member.id = queued.recipient_member_id
       and member.id = any(review.eligible_operator_ids)
      join public.member_message_preferences as preference
        on preference.member_id = member.id
       and preference.operator_alert_enabled is true
      where review.id = queued.review_id
        and review.status = 'IN_REVIEW'
        and review.completed_at is null
        and queued.due_at <= as_of
        and member.role = '운영진'
        and member.is_active is true
        and regexp_replace(coalesce(member.phone, ''), '[^0-9]', '', 'g') ~ '^01[0-9]{8,9}$'
        and not exists (
          select 1
          from public.ot_review_votes as vote
          where vote.review_id = review.id
            and vote.voter_member_id = member.id
        )
    );

  return query
  with ready as (
    select queued.id
    from public.ot_review_reminder_outbox as queued
    join public.ot_reviews as review on review.id = queued.review_id
    left join public.ot_room_invites as invitation on invitation.review_id = review.id
    left join public.ot_signup_reservations as reservation on reservation.invite_id = invitation.id
    join public.members as member
      on member.id = queued.recipient_member_id
     and member.id = any(review.eligible_operator_ids)
    join public.member_message_preferences as preference
      on preference.member_id = member.id
     and preference.operator_alert_enabled is true
    where review.status = 'IN_REVIEW'
      and review.completed_at is null
      and queued.due_at <= as_of
      and member.role = '운영진'
      and member.is_active is true
      and regexp_replace(coalesce(member.phone, ''), '[^0-9]', '', 'g') ~ '^01[0-9]{8,9}$'
      and not exists (
        select 1
        from public.ot_review_votes as vote
        where vote.review_id = review.id
          and vote.voter_member_id = member.id
      )
      and (
        (queued.status in ('QUEUED','FAILED') and queued.next_attempt_at <= as_of)
        or (queued.status = 'SENDING' and queued.locked_at < as_of - interval '10 minutes')
      )
    order by queued.id
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of queued skip locked
  ),
  claimed as (
    update public.ot_review_reminder_outbox as queued
    set status = 'SENDING',
        attempts = queued.attempts + 1,
        locked_at = as_of,
        updated_at = as_of
    from ready
    where queued.id = ready.id
    returning queued.id, queued.review_id, queued.recipient_member_id,
      queued.received_at, queued.due_at, queued.attempts
  )
  select
    claimed.id,
    claimed.review_id,
    claimed.recipient_member_id,
    claimed.received_at,
    claimed.due_at,
    member.name,
    regexp_replace(coalesce(member.phone, ''), '[^0-9]', '', 'g'),
    'https://thisisvom.vercel.app/ot-admin/?id=' || claimed.review_id::text,
    claimed.attempts
  from claimed
  join public.members as member on member.id = claimed.recipient_member_id;
end;
$function$;

revoke all on function public.vom_claim_signup_review_reminders(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.vom_claim_signup_review_reminders(integer, timestamptz)
  to service_role;

create or replace function public.vom_complete_signup_review_reminder(
  p_outbox_id bigint,
  p_sent boolean,
  p_provider_message_id text default null,
  p_error text default null,
  p_retry_at timestamptz default null
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  now_at timestamptz := clock_timestamp();
  updated_count integer;
begin
  update public.ot_review_reminder_outbox
  set status = case when p_sent then 'ACCEPTED' else 'FAILED' end,
      provider_message_id = case when p_sent then nullif(left(coalesce(p_provider_message_id, ''), 160), '') else null end,
      last_error = case when p_sent then null else nullif(left(coalesce(p_error, 'delivery_failed'), 480), '') end,
      accepted_at = case when p_sent then now_at else null end,
      next_attempt_at = case when p_sent then next_attempt_at else coalesce(p_retry_at, now_at + interval '15 minutes') end,
      locked_at = null,
      updated_at = now_at
  where id = p_outbox_id
    and status = 'SENDING';

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$function$;

revoke all on function public.vom_complete_signup_review_reminder(bigint, boolean, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.vom_complete_signup_review_reminder(bigint, boolean, text, text, timestamptz)
  to service_role;
