-- Signup privacy retention and notification-minimization support.
alter table public.ot_room_applicants
  alter column privacy_consent_version set default '2026-11-12';

alter table public.ot_reviews
  add column if not exists privacy_purged_at timestamptz;

create index if not exists ot_reviews_privacy_purge_idx
  on public.ot_reviews(resolved_at, id)
  where status in ('REJECTED', 'DISCARDED')
    and completed_at is null
    and privacy_purged_at is null;

alter table public.signup_message_outbox
  alter column recipient_phone drop not null,
  add column if not exists consent_snapshot boolean not null default true;

-- A result notice is queued only after the applicant explicitly opted in.
-- The outbox can finish delivery after the application profile itself is erased.
update public.signup_message_outbox
set recipient_phone = null,
    recipient_name = '회원',
    payload = '{}'::jsonb,
    updated_at = clock_timestamp()
where status in ('ACCEPTED', 'FAILED', 'SKIPPED')
  and (recipient_phone is not null or recipient_name <> '회원' or payload <> '{}'::jsonb);

comment on column public.ot_room_applicants.privacy_consent_version
  is 'Version of the applicant privacy and retention notice accepted at signup.';
comment on column public.ot_reviews.privacy_purged_at
  is 'When rejected/discarded applicant identifiers and submitted media were purged.';
comment on column public.signup_message_outbox.consent_snapshot
  is 'True only because the applicant opted in before this message was queued; minimal recipient data can outlive the profile until sending finishes.';
