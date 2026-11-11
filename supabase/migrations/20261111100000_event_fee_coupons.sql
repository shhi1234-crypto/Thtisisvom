-- Freeze event pricing at application time and support operator-issued event coupons.

ALTER TABLE public.event_applications
  ADD COLUMN IF NOT EXISTS base_fee_won integer,
  ADD COLUMN IF NOT EXISTS applied_coupon_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS applied_coupons_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS discount_amount_won integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_amount_won integer,
  ADD COLUMN IF NOT EXISTS actual_paid_won integer,
  ADD COLUMN IF NOT EXISTS priority_participant boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS financial_locked_at timestamptz;

UPDATE public.event_applications a
SET base_fee_won = COALESCE(s.fee_won, 0),
    final_amount_won = s.fee_won
FROM public.event_payment_settings s
WHERE s.event_id = a.event_id AND s.fee_won IS NOT NULL;

UPDATE public.event_applications
SET financial_locked_at = COALESCE(confirmed_at, paid_at, applied_at)
WHERE (status = 'CONFIRMED' OR payment_status = 'PAID') AND financial_locked_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_applications_fee_bounds' AND conrelid = 'public.event_applications'::regclass) THEN
    ALTER TABLE public.event_applications ADD CONSTRAINT event_applications_fee_bounds
      CHECK (((base_fee_won IS NULL AND final_amount_won IS NULL AND discount_amount_won = 0)
          OR (base_fee_won IS NOT NULL AND final_amount_won IS NOT NULL
            AND base_fee_won BETWEEN 0 AND 1000000 AND discount_amount_won BETWEEN 0 AND base_fee_won
            AND final_amount_won = base_fee_won - discount_amount_won))
        AND (actual_paid_won IS NULL OR actual_paid_won BETWEEN 0 AND 1000000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_applications_coupon_snapshot_object' AND conrelid = 'public.event_applications'::regclass) THEN
    ALTER TABLE public.event_applications ADD CONSTRAINT event_applications_coupon_snapshot_object
      CHECK (jsonb_typeof(applied_coupons_snapshot) = 'array');
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS event_applications_member_applied_idx ON public.event_applications(member_id, applied_at DESC);

CREATE TABLE IF NOT EXISTS public.event_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  coupon_type text NOT NULL CHECK (coupon_type IN ('FIXED', 'PERCENT', 'FULL', 'PRIORITY')),
  value integer,
  allowed_event_id bigint REFERENCES public.events(id) ON DELETE CASCADE,
  allowed_member_id bigint REFERENCES public.members(id) ON DELETE CASCADE,
  valid_from timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  one_time boolean NOT NULL DEFAULT true,
  stackable boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  issued_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_coupons_value_matches_type CHECK (
    (coupon_type = 'FIXED' AND value IS NOT NULL AND value BETWEEN 1 AND 1000000)
    OR (coupon_type = 'PERCENT' AND value IS NOT NULL AND value BETWEEN 1 AND 100)
    OR (coupon_type IN ('FULL', 'PRIORITY') AND value IS NULL)
  ),
  CONSTRAINT event_coupons_expiry_order CHECK (expires_at IS NULL OR expires_at > valid_from),
  CONSTRAINT event_coupons_priority_is_operator_granted CHECK (coupon_type <> 'PRIORITY' OR (issued_by IS NOT NULL AND allowed_member_id IS NOT NULL AND one_time))
);

CREATE TABLE IF NOT EXISTS public.event_coupon_redemptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coupon_id uuid NOT NULL REFERENCES public.event_coupons(id) ON DELETE RESTRICT,
  application_id bigint NOT NULL REFERENCES public.event_applications(id) ON DELETE CASCADE,
  member_id bigint NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'USED', 'RELEASED')),
  discount_amount_won integer NOT NULL DEFAULT 0 CHECK (discount_amount_won >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  UNIQUE (coupon_id, application_id)
);
CREATE INDEX IF NOT EXISTS event_coupons_available_idx ON public.event_coupons(allowed_event_id, allowed_member_id, is_active, expires_at);
CREATE INDEX IF NOT EXISTS event_coupon_redemptions_coupon_idx ON public.event_coupon_redemptions(coupon_id, status);

CREATE TABLE IF NOT EXISTS public.event_application_financial_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id bigint NOT NULL REFERENCES public.event_applications(id) ON DELETE CASCADE,
  changed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  before_values jsonb NOT NULL CHECK (jsonb_typeof(before_values) = 'object'),
  after_values jsonb NOT NULL CHECK (jsonb_typeof(after_values) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_application_financial_history_application_idx
  ON public.event_application_financial_history(application_id, created_at DESC);

ALTER TABLE public.event_coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_application_financial_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_coupons, public.event_coupon_redemptions, public.event_application_financial_history FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.event_coupons, public.event_coupon_redemptions, public.event_application_financial_history TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.event_coupon_redemptions_id_seq, public.event_application_financial_history_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.vom_event_coupon_price(
  p_event_id bigint, p_member_id bigint, p_base_fee_won integer, p_coupon_ids uuid[], p_application_id bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  ids uuid[] := COALESCE(p_coupon_ids, '{}'::uuid[]);
  coupon public.event_coupons%rowtype;
  remaining integer := p_base_fee_won;
  discount integer;
  used_count integer;
  current_status text;
  current_coupon_ids uuid[];
  coupon_count integer;
  snapshot jsonb := '[]'::jsonb;
  discounts jsonb := '[]'::jsonb;
  is_priority boolean := false;
BEGIN
  IF p_base_fee_won IS NULL OR p_base_fee_won NOT BETWEEN 0 AND 1000000 THEN
    RAISE EXCEPTION 'invalid_base_fee' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO coupon_count FROM unnest(ids) AS requested(id);
  IF coupon_count <> (SELECT count(DISTINCT id) FROM unnest(ids) AS requested(id)) THEN
    RAISE EXCEPTION 'duplicate_coupon' USING ERRCODE = 'P0001';
  END IF;
  IF coupon_count > 4 THEN RAISE EXCEPTION 'too_many_coupons' USING ERRCODE = 'P0001'; END IF;
  IF coupon_count > 1 AND EXISTS (
    SELECT 1 FROM public.event_coupons c WHERE c.id = ANY(ids) AND c.stackable = false
  ) THEN RAISE EXCEPTION 'coupon_not_stackable' USING ERRCODE = 'P0001'; END IF;

  FOR coupon IN
    SELECT c.* FROM public.event_coupons c WHERE c.id = ANY(ids)
    ORDER BY CASE c.coupon_type WHEN 'FIXED' THEN 1 WHEN 'PERCENT' THEN 2 WHEN 'FULL' THEN 3 ELSE 4 END,
      c.value DESC NULLS LAST, c.id FOR UPDATE
  LOOP
    IF NOT coupon.is_active OR coupon.valid_from > now() OR (coupon.expires_at IS NOT NULL AND coupon.expires_at <= now())
      OR (coupon.allowed_event_id IS NOT NULL AND coupon.allowed_event_id <> p_event_id)
      OR (coupon.allowed_member_id IS NOT NULL AND coupon.allowed_member_id <> p_member_id) THEN
      RAISE EXCEPTION 'coupon_not_available' USING ERRCODE = 'P0001';
    END IF;
    IF coupon.one_time THEN
      current_status := NULL;
      current_coupon_ids := '{}'::uuid[];
      IF p_application_id IS NOT NULL THEN
        SELECT status, applied_coupon_ids INTO current_status, current_coupon_ids
        FROM public.event_applications WHERE id = p_application_id;
      END IF;
      SELECT count(*) INTO used_count FROM public.event_coupon_redemptions r
      WHERE r.coupon_id = coupon.id AND r.member_id = p_member_id AND r.status <> 'RELEASED'
        AND NOT (p_application_id IS NOT NULL AND r.application_id = p_application_id
          AND r.status = 'RESERVED' AND current_status IN ('APPLIED', 'CONFIRMED'))
        AND NOT (p_application_id IS NOT NULL AND r.application_id = p_application_id
          AND r.status = 'USED' AND current_status IN ('APPLIED', 'CONFIRMED') AND coupon.id = ANY(current_coupon_ids));
      IF used_count > 0 THEN RAISE EXCEPTION 'coupon_already_used' USING ERRCODE = 'P0001'; END IF;
    END IF;
    discount := 0;
    IF coupon.coupon_type = 'FIXED' THEN
      discount := LEAST(remaining, coupon.value);
    ELSIF coupon.coupon_type = 'PERCENT' THEN
      discount := FLOOR(remaining * coupon.value / 100.0)::integer;
    ELSIF coupon.coupon_type = 'FULL' THEN
      discount := remaining;
    ELSIF coupon.coupon_type = 'PRIORITY' THEN
      is_priority := true;
    END IF;
    remaining := GREATEST(0, remaining - discount);
    discounts := discounts || jsonb_build_array(jsonb_build_object('id', coupon.id, 'discount_amount_won', discount));
    snapshot := snapshot || jsonb_build_array(jsonb_build_object('id', coupon.id, 'title', coupon.title,
      'coupon_type', coupon.coupon_type, 'value', coupon.value, 'discount_amount_won', discount,
      'one_time', coupon.one_time, 'stackable', coupon.stackable));
  END LOOP;
  IF coupon_count <> (SELECT count(*) FROM public.event_coupons c WHERE c.id = ANY(ids)) THEN
    RAISE EXCEPTION 'coupon_not_found' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('coupon_ids', to_jsonb(ids), 'snapshot', snapshot, 'discounts', discounts,
    'discount_amount_won', p_base_fee_won - remaining, 'final_amount_won', remaining, 'priority_participant', is_priority);
END;
$$;

CREATE OR REPLACE FUNCTION public.vom_event_application_change(
  p_event_id bigint, p_member_id bigint, p_action text, p_coupon_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  ev public.events%rowtype;
  found_app public.event_applications%rowtype;
  result_app public.event_applications%rowtype;
  setting public.event_payment_settings%rowtype;
  active_count integer;
  pricing jsonb;
  item jsonb;
BEGIN
  IF p_action NOT IN ('apply', 'cancel') THEN RAISE EXCEPTION 'unsupported_application_action' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO ev FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.members WHERE id = p_member_id AND is_active AND auth_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'member_not_active' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO found_app FROM public.event_applications WHERE event_id = p_event_id AND member_id = p_member_id;
  IF p_action = 'cancel' THEN
    IF found_app.id IS NULL OR found_app.status = 'CANCELLED' THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE = 'P0001'; END IF;
    UPDATE public.event_applications SET status = 'CANCELLED', cancelled_at = now(), confirmed_at = NULL,
      payment_status = CASE WHEN payment_status = 'PAID' THEN 'REFUND_PENDING' ELSE payment_status END, updated_at = now()
      WHERE id = found_app.id RETURNING * INTO result_app;
    UPDATE public.event_coupon_redemptions SET status = CASE WHEN found_app.payment_status = 'PAID' OR found_app.status = 'CONFIRMED' THEN 'USED' ELSE 'RELEASED' END,
      used_at = CASE WHEN found_app.payment_status = 'PAID' OR found_app.status = 'CONFIRMED' THEN COALESCE(used_at, now()) ELSE used_at END
      WHERE application_id = found_app.id AND status = 'RESERVED';
    RETURN jsonb_build_object('status', result_app.status, 'id', result_app.id, 'payment_status', result_app.payment_status,
      'final_amount_won', result_app.final_amount_won, 'discount_amount_won', result_app.discount_amount_won);
  END IF;

  IF ev.event_date < DATE '2026-11-01' OR NOT ev.application_enabled OR ev.application_capacity IS NULL THEN
    RAISE EXCEPTION 'applications_not_enabled' USING ERRCODE = 'P0001';
  END IF;
  IF now() < timestamptz '2026-10-19 20:00:00+09' OR (ev.application_opens_at IS NOT NULL AND now() < ev.application_opens_at) THEN
    RAISE EXCEPTION 'applications_not_open' USING ERRCODE = 'P0001';
  END IF;
  IF ev.event_date <= (now() AT TIME ZONE 'Asia/Seoul')::date OR (ev.application_closes_at IS NOT NULL AND now() >= ev.application_closes_at) THEN
    RAISE EXCEPTION 'applications_closed' USING ERRCODE = 'P0001';
  END IF;
  IF found_app.id IS NOT NULL AND found_app.status IN ('APPLIED', 'CONFIRMED') THEN
    RETURN jsonb_build_object('status', found_app.status, 'id', found_app.id, 'payment_status', found_app.payment_status,
      'final_amount_won', found_app.final_amount_won, 'discount_amount_won', found_app.discount_amount_won);
  END IF;
  IF found_app.payment_status = 'REFUND_PENDING' THEN RAISE EXCEPTION 'refund_pending' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO setting FROM public.event_payment_settings WHERE event_id = p_event_id FOR SHARE;
  IF NOT FOUND OR setting.fee_won IS NULL THEN RAISE EXCEPTION 'event_fee_not_configured' USING ERRCODE = 'P0001'; END IF;
  pricing := public.vom_event_coupon_price(p_event_id, p_member_id, setting.fee_won, p_coupon_ids, found_app.id);
  SELECT count(*) INTO active_count FROM public.event_applications WHERE event_id = p_event_id AND status IN ('APPLIED', 'CONFIRMED');
  IF active_count >= ev.application_capacity AND (pricing->>'priority_participant')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'applications_full' USING ERRCODE = 'P0001';
  END IF;
  IF found_app.id IS NOT NULL THEN
    UPDATE public.event_applications SET status = 'APPLIED', applied_at = now(), confirmed_at = NULL, cancelled_at = NULL,
      payment_status = 'UNPAID', paid_at = NULL, paid_recorded_by = NULL, refunded_at = NULL, refunded_recorded_by = NULL,
      base_fee_won = setting.fee_won, applied_coupon_ids = ARRAY(SELECT jsonb_array_elements_text(pricing->'coupon_ids')::uuid),
      applied_coupons_snapshot = pricing->'snapshot', discount_amount_won = (pricing->>'discount_amount_won')::integer,
      final_amount_won = (pricing->>'final_amount_won')::integer, actual_paid_won = NULL,
      priority_participant = (pricing->>'priority_participant')::boolean, financial_locked_at = NULL, updated_at = now()
      WHERE id = found_app.id RETURNING * INTO result_app;
    UPDATE public.event_coupon_redemptions SET status = 'RELEASED'
      WHERE application_id = result_app.id AND status <> 'USED';
  ELSE
    INSERT INTO public.event_applications(event_id, member_id, base_fee_won, applied_coupon_ids, applied_coupons_snapshot,
      discount_amount_won, final_amount_won, priority_participant)
      VALUES (p_event_id, p_member_id, setting.fee_won,
        ARRAY(SELECT jsonb_array_elements_text(pricing->'coupon_ids')::uuid), pricing->'snapshot',
        (pricing->>'discount_amount_won')::integer, (pricing->>'final_amount_won')::integer,
        (pricing->>'priority_participant')::boolean) RETURNING * INTO result_app;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(pricing->'discounts') LOOP
    INSERT INTO public.event_coupon_redemptions AS current_redemption(coupon_id, application_id, member_id, event_id, status, discount_amount_won)
      VALUES ((item->>'id')::uuid, result_app.id, p_member_id, p_event_id, 'RESERVED', (item->>'discount_amount_won')::integer)
      ON CONFLICT (coupon_id, application_id) DO UPDATE SET status = 'RESERVED', discount_amount_won = excluded.discount_amount_won, used_at = NULL;
  END LOOP;
  RETURN jsonb_build_object('status', result_app.status, 'id', result_app.id, 'payment_status', result_app.payment_status,
    'base_fee_won', result_app.base_fee_won, 'discount_amount_won', result_app.discount_amount_won,
    'final_amount_won', result_app.final_amount_won, 'priority_participant', result_app.priority_participant);
END;
$$;

CREATE OR REPLACE FUNCTION public.vom_event_application_change(p_event_id bigint, p_member_id bigint, p_action text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.vom_event_application_change(p_event_id, p_member_id, p_action, '{}'::uuid[])
$$;

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
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = p_actor_id) THEN RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001'; END IF;
  IF p_actual_paid_won IS NOT NULL AND p_actual_paid_won NOT BETWEEN 0 AND 1000000 THEN RAISE EXCEPTION 'invalid_actual_paid' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO app FROM public.event_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE = 'P0001'; END IF;
  IF app.status = 'CANCELLED' OR app.payment_status IN ('REFUND_PENDING', 'REFUNDED') THEN
    RAISE EXCEPTION 'refund_financial_locked' USING ERRCODE = 'P0001';
  END IF;
  IF app.financial_locked_at IS NOT NULL AND (reason_text IS NULL OR length(reason_text) > 500) THEN
    RAISE EXCEPTION 'financial_locked_reason_required' USING ERRCODE = 'P0001';
  END IF;
  pricing := public.vom_event_coupon_price(app.event_id, app.member_id, p_base_fee_won, p_coupon_ids, app.id);
  before_values := jsonb_build_object('base_fee_won', app.base_fee_won, 'applied_coupon_ids', app.applied_coupon_ids,
    'applied_coupons_snapshot', app.applied_coupons_snapshot, 'discount_amount_won', app.discount_amount_won,
    'final_amount_won', app.final_amount_won, 'actual_paid_won', app.actual_paid_won);
  after_values := jsonb_build_object('base_fee_won', p_base_fee_won,
    'applied_coupon_ids', ARRAY(SELECT jsonb_array_elements_text(pricing->'coupon_ids')::uuid),
    'applied_coupons_snapshot', pricing->'snapshot', 'discount_amount_won', (pricing->>'discount_amount_won')::integer,
    'final_amount_won', (pricing->>'final_amount_won')::integer, 'actual_paid_won', p_actual_paid_won);
  IF app.financial_locked_at IS NOT NULL THEN
    INSERT INTO public.event_application_financial_history(application_id, changed_by, reason, before_values, after_values)
    VALUES (app.id, p_actor_id, reason_text, before_values, after_values);
  END IF;
  UPDATE public.event_coupon_redemptions SET status = 'RELEASED'
    WHERE application_id = app.id AND status = 'RESERVED';
  UPDATE public.event_applications SET base_fee_won = p_base_fee_won,
    applied_coupon_ids = ARRAY(SELECT jsonb_array_elements_text(pricing->'coupon_ids')::uuid),
    applied_coupons_snapshot = pricing->'snapshot', discount_amount_won = (pricing->>'discount_amount_won')::integer,
    final_amount_won = (pricing->>'final_amount_won')::integer, actual_paid_won = p_actual_paid_won,
    priority_participant = (pricing->>'priority_participant')::boolean, updated_at = now()
    WHERE id = app.id RETURNING * INTO app;
  FOR item IN SELECT value FROM jsonb_array_elements(pricing->'discounts') LOOP
    INSERT INTO public.event_coupon_redemptions(coupon_id, application_id, member_id, event_id, status, discount_amount_won)
    VALUES ((item->>'id')::uuid, app.id, app.member_id, app.event_id,
      CASE WHEN app.payment_status = 'PAID' OR app.status = 'CONFIRMED' THEN 'USED' ELSE 'RESERVED' END,
      (item->>'discount_amount_won')::integer)
    ON CONFLICT (coupon_id, application_id) DO UPDATE SET status = excluded.status,
      discount_amount_won = excluded.discount_amount_won,
      used_at = CASE WHEN excluded.status = 'USED' THEN COALESCE(current_redemption.used_at, now()) ELSE NULL END;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'application', jsonb_build_object('id', app.id, 'base_fee_won', app.base_fee_won,
    'discount_amount_won', app.discount_amount_won, 'final_amount_won', app.final_amount_won,
    'actual_paid_won', app.actual_paid_won, 'financial_locked_at', app.financial_locked_at));
END;
$$;

REVOKE ALL ON FUNCTION public.vom_event_coupon_price(bigint,bigint,integer,uuid[],bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vom_event_application_change(bigint,bigint,text,uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vom_event_application_change(bigint,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vom_event_application_financial_update(bigint,uuid,integer,uuid[],integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vom_event_application_change(bigint,bigint,text,uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.vom_event_application_change(bigint,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.vom_event_application_financial_update(bigint,uuid,integer,uuid[],integer,text) TO service_role;

