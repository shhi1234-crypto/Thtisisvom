alter table public.member_message_preferences
  add column if not exists urgent_contact_enabled boolean not null default false,
  add column if not exists urgent_contact_consented_at timestamptz,
  add column if not exists member_notice_enabled boolean not null default false,
  add column if not exists member_notice_consented_at timestamptz;

comment on column public.member_message_preferences.urgent_contact_enabled is 'Member consent to be contacted by VOM operators for urgent schedule or safety notices.';
comment on column public.member_message_preferences.urgent_contact_consented_at is 'Timestamp of the current urgent contact consent.';
comment on column public.member_message_preferences.member_notice_enabled is 'Member consent to receive general VOM notices and operational announcements by AlimTalk.';
comment on column public.member_message_preferences.member_notice_consented_at is 'Timestamp of the current general member notice consent.';
