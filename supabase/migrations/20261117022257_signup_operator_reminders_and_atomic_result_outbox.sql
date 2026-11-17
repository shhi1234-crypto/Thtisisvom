-- Durable, deduplicated AlimTalk reminders for operators who have not voted.
CREATE TABLE IF NOT EXISTS public.ot_operator_message_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_id bigint NOT NULL REFERENCES public.ot_reviews(id) ON DELETE CASCADE,
  recipient_member_id bigint NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  message_kind text NOT NULL CHECK (message_kind IN ('SIGNUP_OPERATOR_REVIEW_30M','SIGNUP_OPERATOR_REVIEW_6H')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENDING','ACCEPTED','FAILED','SKIPPED','WAITING_FOR_CONFIGURATION')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  provider_message_id text,
  accepted_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, recipient_member_id, message_kind)
);

CREATE INDEX IF NOT EXISTS ot_operator_message_outbox_queue_idx
  ON public.ot_operator_message_outbox(status, next_attempt_at, id)
  WHERE status IN ('QUEUED','WAITING_FOR_CONFIGURATION');

ALTER TABLE public.ot_operator_message_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ot_operator_message_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ot_operator_message_outbox TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ot_operator_message_outbox_id_seq TO service_role;

-- Couple the member-facing result notice to the approval/rejection transaction.
-- The existing AFTER trigger and queue upsert are idempotent, so the Edge Function
-- may safely keep its defensive queue call as well.
CREATE OR REPLACE FUNCTION private.vom_ot_queue_signup_result()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result_kind text;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status OR NEW.status NOT IN ('APPROVED','REJECTED') THEN
    RETURN NEW;
  END IF;

  result_kind := CASE NEW.status
    WHEN 'APPROVED' THEN 'SIGNUP_APPROVED'
    ELSE 'SIGNUP_REJECTED'
  END;

  INSERT INTO public.signup_message_outbox(
    invite_id, review_id, message_kind, recipient_phone, recipient_name,
    dedupe_key, payload, status, next_attempt_at, updated_at
  )
  SELECT
    invitation.id,
    NEW.id,
    result_kind,
    preference.phone,
    applicant.candidate_name,
    result_kind || ':' || NEW.id::text,
    jsonb_build_object(
      'recipient_name', applicant.candidate_name,
      'applicant_name', applicant.candidate_name,
      'confirmation_url', CASE WHEN result_kind = 'SIGNUP_APPROVED' THEN 'https://thisisvom.vercel.app/me/' ELSE '' END,
      'fallback_sms_enabled', false
    ),
    'QUEUED',
    clock_timestamp(),
    clock_timestamp()
  FROM public.ot_room_invites invitation
  JOIN public.ot_room_applicants applicant ON applicant.invite_id = invitation.id
  JOIN public.signup_message_preferences preference ON preference.invite_id = invitation.id
  WHERE invitation.review_id = NEW.id
    AND preference.enabled IS TRUE
    AND preference.phone ~ '^01[0-9]{8,9}$'
  ON CONFLICT (invite_id, dedupe_key) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.vom_ot_queue_signup_result() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vom_ot_queue_signup_result ON public.ot_reviews;
CREATE TRIGGER vom_ot_queue_signup_result
AFTER UPDATE OF status ON public.ot_reviews
FOR EACH ROW
EXECUTE FUNCTION private.vom_ot_queue_signup_result();

