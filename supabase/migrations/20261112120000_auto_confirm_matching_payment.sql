-- Match the recorded transfer against the member-specific final amount and confirm atomically.

ALTER TABLE public.event_applications
  DROP CONSTRAINT IF EXISTS vom_event_application_payment_status;

ALTER TABLE public.event_applications
  ADD CONSTRAINT vom_event_application_payment_status
  CHECK (payment_status IN ('UNPAID', 'PAYMENT_REVIEW', 'PAID', 'REFUND_PENDING', 'REFUNDED'));

CREATE OR REPLACE FUNCTION public.vom_event_application_financial_update(
  p_application_id bigint, p_actor_id uuid, p_base_fee_won integer, p_coupon_ids uuid[], p_actual_paid_won integer, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  app public.event_applications%rowtype;
  pricing jsonb;
  before_values jsonb;
  after_values jsonb;
  item jsonb;
  reason_text text := NULLIF(btrim(p_reason), '');
  changed_at timestamptz := clock_timestamp();
  matches_final boolean;
  auto_confirmed boolean;
  next_status text;
  next_payment_status text;
  next_confirmed_at timestamptz;
  next_paid_at timestamptz;
  next_paid_recorded_by uuid;
  next_financial_locked_at timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = p_actor_id) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;
  IF p_actual_paid_won IS NOT NULL AND p_actual_paid_won NOT BETWEEN 0 AND 1000000 THEN
    RAISE EXCEPTION 'invalid_actual_paid' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO app FROM public.event_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE = 'P0001'; END IF;
  IF app.status = 'CANCELLED' OR app.payment_status IN ('REFUND_PENDING', 'REFUNDED') THEN
    RAISE EXCEPTION 'refund_financial_locked' USING ERRCODE = 'P0001';
  END IF;
  IF app.financial_locked_at IS NOT NULL AND (reason_text IS NULL OR length(reason_text) > 500) THEN
    RAISE EXCEPTION 'financial_locked_reason_required' USING ERRCODE = 'P0001';
  END IF;

  pricing := public.vom_event_coupon_price(app.event_id, app.member_id, p_base_fee_won, p_coupon_ids, app.id);
  matches_final := p_actual_paid_won IS NOT NULL
    AND p_actual_paid_won = (pricing->>'final_amount_won')::integer;
  auto_confirmed := matches_final AND app.status <> 'CONFIRMED';

  IF matches_final THEN
    next_status := 'CONFIRMED';
    next_payment_status := 'PAID';
    next_confirmed_at := COALESCE(app.confirmed_at, changed_at);
    next_paid_at := COALESCE(app.paid_at, changed_at);
    next_paid_recorded_by := p_actor_id;
    next_financial_locked_at := COALESCE(app.financial_locked_at, changed_at);
  ELSIF p_actual_paid_won IS NOT NULL THEN
    next_status := 'APPLIED';
    next_payment_status := 'PAYMENT_REVIEW';
    next_confirmed_at := NULL;
    next_paid_at := NULL;
    next_paid_recorded_by := NULL;
    next_financial_locked_at := NULL;
  ELSE
    next_status := 'APPLIED';
    next_payment_status := 'UNPAID';
    next_confirmed_at := NULL;
    next_paid_at := NULL;
    next_paid_recorded_by := NULL;
    next_financial_locked_at := NULL;
  END IF;

  before_values := jsonb_build_object(
    'base_fee_won', app.base_fee_won, 'applied_coupon_ids', app.applied_coupon_ids,
    'applied_coupons_snapshot', app.applied_coupons_snapshot, 'discount_amount_won', app.discount_amount_won,
    'final_amount_won', app.final_amount_won, 'actual_paid_won', app.actual_paid_won,
    'status', app.status, 'payment_status', app.payment_status
  );
  after_values := jsonb_build_object(
    'base_fee_won', p_base_fee_won,
    'applied_coupon_ids', ARRAY(SELECT jsonb_array_elements_text(pricing->'coupon_ids')::uuid),
    'applied_coupons_snapshot', pricing->'snapshot', 'discount_amount_won', (pricing->>'discount_amount_won')::integer,
    'final_amount_won', (pricing->>'final_amount_won')::integer, 'actual_paid_won', p_actual_paid_won,
    'status', next_status, 'payment_status', next_payment_status
  );

  IF app.financial_locked_at IS NOT NULL THEN
    INSERT INTO public.event_application_financial_history(application_id, changed_by, reason, before_values, after_values)
    VALUES (app.id, p_actor_id, reason_text, before_values, after_values);
  END IF;

  UPDATE public.event_coupon_redemptions SET status = 'RELEASED', used_at = NULL
    WHERE application_id = app.id AND status IN ('RESERVED', 'USED');

  UPDATE public.event_applications SET
    status = next_status,
    payment_status = next_payment_status,
    confirmed_at = next_confirmed_at,
    paid_at = next_paid_at,
    paid_recorded_by = next_paid_recorded_by,
    financial_locked_at = next_financial_locked_at,
    base_fee_won = p_base_fee_won,
    applied_coupon_ids = ARRAY(SELECT jsonb_array_elements_text(pricing->'coupon_ids')::uuid),
    applied_coupons_snapshot = pricing->'snapshot',
    discount_amount_won = (pricing->>'discount_amount_won')::integer,
    final_amount_won = (pricing->>'final_amount_won')::integer,
    actual_paid_won = p_actual_paid_won,
    priority_participant = (pricing->>'priority_participant')::boolean,
    updated_at = changed_at
    WHERE id = app.id RETURNING * INTO app;

  FOR item IN SELECT value FROM jsonb_array_elements(pricing->'discounts') LOOP
    INSERT INTO public.event_coupon_redemptions AS current_redemption(coupon_id, application_id, member_id, event_id, status, discount_amount_won)
    VALUES ((item->>'id')::uuid, app.id, app.member_id, app.event_id,
      CASE WHEN next_payment_status = 'PAID' THEN 'USED' ELSE 'RESERVED' END,
      (item->>'discount_amount_won')::integer)
    ON CONFLICT (coupon_id, application_id) DO UPDATE SET
      status = excluded.status,
      discount_amount_won = excluded.discount_amount_won,
      used_at = CASE WHEN excluded.status = 'USED' THEN COALESCE(current_redemption.used_at, changed_at) ELSE NULL END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'auto_confirmed', auto_confirmed,
    'status', app.status,
    'payment_status', app.payment_status,
    'application', jsonb_build_object(
      'id', app.id, 'status', app.status, 'payment_status', app.payment_status,
      'base_fee_won', app.base_fee_won, 'discount_amount_won', app.discount_amount_won,
      'final_amount_won', app.final_amount_won, 'actual_paid_won', app.actual_paid_won,
      'confirmed_at', app.confirmed_at, 'financial_locked_at', app.financial_locked_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.vom_event_application_financial_update(bigint,uuid,integer,uuid[],integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vom_event_application_financial_update(bigint,uuid,integer,uuid[],integer,text) TO service_role;

