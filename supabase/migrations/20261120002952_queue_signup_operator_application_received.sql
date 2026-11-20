ALTER TABLE public.ot_operator_message_outbox
  DROP CONSTRAINT IF EXISTS ot_operator_message_outbox_message_kind_check;
ALTER TABLE public.ot_operator_message_outbox
  ADD CONSTRAINT ot_operator_message_outbox_message_kind_check
  CHECK (message_kind IN (
    'SIGNUP_OPERATOR_REVIEW_30M',
    'SIGNUP_OPERATOR_REVIEW_6H',
    'SIGNUP_OPERATOR_APPLICATION_RECEIVED'
  ));

CREATE OR REPLACE FUNCTION public.vom_queue_signup_operator_application_received()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM 'IN_REVIEW' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.ot_operator_message_outbox (
    review_id,
    recipient_member_id,
    message_kind,
    status,
    next_attempt_at
  )
  SELECT
    NEW.id,
    member.id,
    'SIGNUP_OPERATOR_APPLICATION_RECEIVED',
    'QUEUED',
    clock_timestamp()
  FROM public.members AS member
  JOIN public.member_message_preferences AS preference
    ON preference.member_id = member.id
   AND preference.operator_alert_enabled IS TRUE
  WHERE member.id = ANY(COALESCE(NEW.eligible_operator_ids, ARRAY[]::bigint[]))
    AND member.is_active IS TRUE
    AND member.role IN ('운영진', '모임장')
    AND NULLIF(BTRIM(member.phone), '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.ot_review_votes AS vote
      WHERE vote.review_id = NEW.id
        AND vote.voter_member_id = member.id
    )
  ON CONFLICT (review_id, recipient_member_id, message_kind) DO NOTHING;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.vom_queue_signup_operator_application_received() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vom_queue_signup_operator_application_received() TO service_role;

DROP TRIGGER IF EXISTS ot_queue_signup_operator_application_received ON public.ot_reviews;
CREATE TRIGGER ot_queue_signup_operator_application_received
AFTER INSERT ON public.ot_reviews
FOR EACH ROW
EXECUTE FUNCTION public.vom_queue_signup_operator_application_received();

