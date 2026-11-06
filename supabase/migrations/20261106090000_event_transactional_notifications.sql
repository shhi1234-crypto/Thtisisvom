-- Private contact preferences and a durable outbound queue for event notices.
-- The browser never reads these tables directly; authenticated Edge Functions do.

ALTER TABLE public.event_payment_settings
  ADD COLUMN IF NOT EXISTS messaging_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS message_sms_fallback_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmed_chat_url text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_payment_settings_confirmed_chat_url_length'
      AND conrelid = 'public.event_payment_settings'::regclass
  ) THEN
    ALTER TABLE public.event_payment_settings
      ADD CONSTRAINT event_payment_settings_confirmed_chat_url_length
      CHECK (confirmed_chat_url IS NULL OR length(confirmed_chat_url) <= 2048);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.member_message_preferences (
  member_id bigint PRIMARY KEY REFERENCES public.members(id) ON DELETE CASCADE,
  event_transaction_enabled boolean NOT NULL DEFAULT false,
  event_transaction_consented_at timestamptz,
  operator_alert_enabled boolean NOT NULL DEFAULT false,
  operator_alert_consented_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.member_message_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_message_preferences FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.member_message_preferences TO service_role;

CREATE TABLE IF NOT EXISTS public.event_message_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  application_id bigint NOT NULL REFERENCES public.event_applications(id) ON DELETE CASCADE,
  recipient_member_id bigint NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  message_kind text NOT NULL CHECK (message_kind IN (
    'MEMBER_APPLICATION_RECEIVED',
    'MEMBER_PAYMENT_CONFIRMED',
    'MEMBER_PARTICIPATION_CONFIRMED',
    'MEMBER_APPLICATION_CANCELLED',
    'OPERATOR_APPLICATION_RECEIVED',
    'OPERATOR_APPLICATION_CANCELLED'
  )),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 180),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN (
    'QUEUED', 'SENDING', 'ACCEPTED', 'FAILED', 'SKIPPED', 'WAITING_FOR_CONFIGURATION'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  provider_message_id text,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_message_outbox_dedupe UNIQUE (recipient_member_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS event_message_outbox_pending_idx
  ON public.event_message_outbox(status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS event_message_outbox_event_idx
  ON public.event_message_outbox(event_id, created_at DESC);

ALTER TABLE public.event_message_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.event_message_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.event_message_outbox TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.event_message_outbox_id_seq TO service_role;

