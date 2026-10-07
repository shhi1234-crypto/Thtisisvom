-- Internal submission records remain private; public registration needs no invite URL.
alter table public.ot_room_invites
  add column signup_source text not null default 'INVITE' check (signup_source in ('INVITE','PUBLIC')),
  add column notification_token_hash text unique check (notification_token_hash ~ '^[a-f0-9]{64}$'),
  add column notification_expires_at timestamptz,
  add column notification_push_enabled boolean not null default false;
alter table public.ot_reviews
  add column approval_notified_at timestamptz,
  add column approval_notification_attempts integer not null default 0,
  add column approval_notification_next_attempt_at timestamptz not null default now(),
  add column approval_notification_claimed_at timestamptz;
create index ot_approval_notification_queue on public.ot_reviews (approval_notification_next_attempt_at)
  where status='APPROVED' and approval_notified_at is null;
create table public.ot_applicant_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null unique references public.ot_room_invites(id) on delete cascade,
  endpoint text not null check(char_length(endpoint) between 20 and 2048),
  p256dh text not null check(char_length(p256dh) between 80 and 150),
  auth text not null check(char_length(auth) between 20 and 50),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ot_applicant_push_subscriptions enable row level security;
revoke all on public.ot_applicant_push_subscriptions from public,anon,authenticated;
grant all on public.ot_applicant_push_subscriptions to service_role;
comment on table public.ot_applicant_push_subscriptions is 'Private applicant device subscriptions; approval-only push, managed by service role.';
