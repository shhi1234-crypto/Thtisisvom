-- Payment guidance is only returned to authenticated members via event-application.
-- Do not store bank/account information in public.events.
CREATE TABLE IF NOT EXISTS public.event_payment_settings (
  event_id bigint PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  fee_won integer CHECK (fee_won IS NULL OR (fee_won >= 0 AND fee_won <= 1000000)),
  payment_instructions text CHECK (payment_instructions IS NULL OR length(payment_instructions) <= 500),
  refund_instructions text CHECK (refund_instructions IS NULL OR length(refund_instructions) <= 500),
  payment_due_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.event_payment_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_payment_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.event_payment_settings TO service_role;

ALTER TABLE public.event_applications
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'UNPAID',
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_recorded_by uuid,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_recorded_by uuid;
ALTER TABLE public.event_applications
  ADD CONSTRAINT vom_event_application_payment_status
  CHECK (payment_status IN ('UNPAID','PAID','REFUND_PENDING','REFUNDED'));
CREATE INDEX IF NOT EXISTS event_applications_refund_pending_idx
 ON public.event_applications(event_id) WHERE payment_status='REFUND_PENDING';

-- Preserve existing application/confirmation behavior while atomically tracking
-- pending refunds and preventing reapplication until a pending refund is resolved.
CREATE OR REPLACE FUNCTION public.vom_event_application_change(
  p_event_id bigint,p_member_id bigint,p_action text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  ev public.events%rowtype;
  found_app public.event_applications%rowtype;
  active_count integer;
  result_app public.event_applications%rowtype;
BEGIN
  IF p_action NOT IN ('apply','cancel') THEN
    RAISE EXCEPTION 'unsupported_application_action' USING errcode='P0001';
  END IF;
  SELECT * INTO ev FROM public.events WHERE id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found' USING errcode='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.members WHERE id=p_member_id AND is_active AND auth_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'member_not_active' USING errcode='P0001';
  END IF;
  SELECT * INTO found_app FROM public.event_applications WHERE event_id=p_event_id AND member_id=p_member_id;
  IF p_action='cancel' THEN
    IF found_app.id IS NULL OR found_app.status='CANCELLED' THEN
      RAISE EXCEPTION 'application_not_found' USING errcode='P0001';
    END IF;
    UPDATE public.event_applications
      SET status='CANCELLED', cancelled_at=now(),confirmed_at=NULL,
          payment_status=CASE WHEN payment_status='PAID' THEN 'REFUND_PENDING' ELSE payment_status END,
          updated_at=now()
      WHERE id=found_app.id RETURNING * INTO result_app;
    RETURN jsonb_build_object('status',result_app.status,'id',result_app.id,'payment_status',result_app.payment_status);
  END IF;

  IF ev.event_date < DATE '2026-11-01' OR NOT ev.application_enabled OR ev.application_capacity IS NULL THEN
    RAISE EXCEPTION 'applications_not_enabled' USING errcode='P0001';
  END IF;
  IF now() < timestamptz '2026-10-19 20:00:00+09'
     OR (ev.application_opens_at IS NOT NULL AND now()<ev.application_opens_at) THEN
    RAISE EXCEPTION 'applications_not_open' USING errcode='P0001';
  END IF;
  IF ev.event_date <= (now() AT TIME ZONE 'Asia/Seoul')::date
    OR (ev.application_closes_at IS NOT NULL AND now()>=ev.application_closes_at) THEN
    RAISE EXCEPTION 'applications_closed' USING errcode='P0001';
  END IF;
  IF found_app.id IS NOT NULL AND found_app.status IN ('APPLIED','CONFIRMED') THEN
    RETURN jsonb_build_object('status',found_app.status,'id',found_app.id,'payment_status',found_app.payment_status);
  END IF;
  IF found_app.payment_status='REFUND_PENDING' THEN
    RAISE EXCEPTION 'refund_pending' USING errcode='P0001';
  END IF;
  SELECT count(*) INTO active_count FROM public.event_applications
    WHERE event_id=p_event_id AND status IN ('APPLIED','CONFIRMED');
  IF active_count >= ev.application_capacity THEN
    RAISE EXCEPTION 'applications_full' USING errcode='P0001';
  END IF;
  IF found_app.id IS NOT NULL THEN
    UPDATE public.event_applications SET
      status='APPLIED',applied_at=now(),confirmed_at=NULL,cancelled_at=NULL,
      payment_status='UNPAID',paid_at=NULL,paid_recorded_by=NULL,
      refunded_at=NULL,refunded_recorded_by=NULL,updated_at=now()
      WHERE id=found_app.id RETURNING * INTO result_app;
  ELSE
    INSERT INTO public.event_applications(event_id,member_id)
      VALUES(p_event_id,p_member_id) RETURNING * INTO result_app;
  END IF;
  RETURN jsonb_build_object('status',result_app.status,'id',result_app.id,'payment_status',result_app.payment_status);
END;
$$;
REVOKE ALL ON FUNCTION public.vom_event_application_change(bigint,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vom_event_application_change(bigint,bigint,text) TO service_role;
