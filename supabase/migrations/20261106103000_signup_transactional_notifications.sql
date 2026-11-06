-- Private AlimTalk outbox for public membership applications.
-- Applicants are not members yet, so this is intentionally separate from the
-- event_message_outbox member FK and remains service-role only.
create table public.signup_message_preferences (
  invite_id uuid primary key references public.ot_room_invites(id) on delete cascade,
  phone text not null check (phone ~ '^01[0-9]{8,9}$'),
  enabled boolean not null default false,
  consented_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.signup_message_preferences enable row level security;
revoke all on public.signup_message_preferences from public, anon, authenticated;
grant all on public.signup_message_preferences to service_role;

create table public.signup_message_outbox (
  id bigint generated always as identity primary key,
  invite_id uuid not null references public.ot_room_invites(id) on delete cascade,
  review_id bigint references public.ot_reviews(id) on delete cascade,
  message_kind text not null check (message_kind in ('SIGNUP_APPLICATION_RECEIVED','SIGNUP_APPROVED','SIGNUP_REJECTED')),
  recipient_phone text not null check (recipient_phone ~ '^01[0-9]{8,9}$'),
  recipient_name text not null check (char_length(recipient_name) between 1 and 60),
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  status text not null default 'QUEUED' check (status in ('QUEUED','SENDING','ACCEPTED','FAILED','SKIPPED','WAITING_FOR_CONFIGURATION')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  provider_message_id text,
  accepted_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invite_id, dedupe_key)
);

alter table public.signup_message_outbox enable row level security;
revoke all on public.signup_message_outbox from public, anon, authenticated;
grant all on public.signup_message_outbox to service_role;

create index signup_message_outbox_queue_idx
  on public.signup_message_outbox(next_attempt_at, id)
  where status in ('QUEUED','WAITING_FOR_CONFIGURATION');

comment on table public.signup_message_preferences is 'Private applicant AlimTalk consent and normalized phone number.';
comment on table public.signup_message_outbox is 'Private transactional AlimTalk queue for membership applications.';

