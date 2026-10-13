-- Prepared for Kakao conversational signup. NOT applied to production by this PR.
create table if not exists public.kakao_signup_drafts (
  id uuid primary key default gen_random_uuid(),
  bot_user_hash text not null unique check (length(bot_user_hash)=64),
  step text not null default 'CONSENT',
  answers jsonb not null default '{}'::jsonb,
  consent_version text,
  consented_at timestamptz,
  upload_token_hash text unique check (upload_token_hash is null or length(upload_token_hash)=64),
  upload_expires_at timestamptz,
  completed_at timestamptz,
  revision integer not null default 0,
  last_request_hash text,
  last_reply jsonb,
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '3 days')
);
create index if not exists kakao_signup_drafts_expiry_idx on public.kakao_signup_drafts(expires_at);
create index if not exists kakao_signup_drafts_upload_lookup_idx
 on public.kakao_signup_drafts(upload_token_hash) where upload_token_hash is not null;
alter table public.kakao_signup_drafts enable row level security;
revoke all on public.kakao_signup_drafts from public,anon,authenticated;
grant all on public.kakao_signup_drafts to service_role;
comment on table public.kakao_signup_drafts is
'Private, temporary chat signup drafts. Verified skill transport secret required for writes; do not use user bot key as login authentication. Delete expired drafts through scheduled maintenance.';

alter table public.ot_room_applicants
  add column if not exists join_reason text
  check (join_reason is null or char_length(join_reason) between 1 and 500);
comment on column public.ot_room_applicants.join_reason is
'Applicant-stated reason for joining VOM, accessible only through authorized OT review flows.';

-- Supabase project currently has pg_cron 1.6.4 installed.
-- Automatically remove abandoned personal information after 72h, including
-- incomplete retries that need a separate operator reconciliation workflow.
select cron.schedule(
 'vom-kakao-signup-expired-drafts',
 '10 * * * *',
 $$delete from public.kakao_signup_drafts where expires_at < now()$$
);
