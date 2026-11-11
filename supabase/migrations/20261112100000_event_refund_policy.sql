-- Event cancellation refunds are calculated in Asia/Seoul and snapshotted when the member cancels.

ALTER TABLE public.event_payment_settings
  ADD COLUMN IF NOT EXISTS headcount_fixed_at timestamptz;

UPDATE public.event_payment_settings p
SET headcount_fixed_at = ((e.event_date - 7)::timestamp AT TIME ZONE 'Asia/Seoul')
FROM public.events e
WHERE e.id = p.event_id AND p.headcount_fixed_at IS NULL;

ALTER TABLE public.event_applications
  ADD COLUMN IF NOT EXISTS refund_rule_code text,
  ADD COLUMN IF NOT EXISTS refund_rate_percent smallint,
  ADD COLUMN IF NOT EXISTS refund_amount_won integer,
  ADD COLUMN IF NOT EXISTS refund_deduction_won integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_applications_refund_rule_code' AND conrelid = 'public.event_applications'::regclass) THEN
    ALTER TABLE public.event_applications ADD CONSTRAINT event_applications_refund_rule_code
      CHECK (refund_rule_code IS NULL OR refund_rule_code IN ('BEFORE_HEADCOUNT_FIX', 'HEADCOUNT_FIX_TO_4_DAYS', '3_DAYS_TO_PREVIOUS_DAY', 'EVENT_DAY'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_applications_refund_values' AND conrelid = 'public.event_applications'::regclass) THEN
    ALTER TABLE public.event_applications ADD CONSTRAINT event_applications_refund_values
      CHECK ((refund_rate_percent IS NULL OR refund_rate_percent IN (0, 50, 80, 100))
        AND (refund_amount_won IS NULL OR refund_amount_won BETWEEN 0 AND 1000000)
        AND (refund_deduction_won IS NULL OR refund_deduction_won BETWEEN 0 AND 1000000));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.event_refund_policy_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  changed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  before_values jsonb NOT NULL CHECK (jsonb_typeof(before_values) = 'object'),
  after_values jsonb NOT NULL CHECK (jsonb_typeof(after_values) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_refund_policy_history_event_idx
  ON public.event_refund_policy_history(event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.event_application_refund_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id bigint NOT NULL REFERENCES public.event_applications(id) ON DELETE RESTRICT,
  event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  member_id bigint NOT NULL REFERENCES public.members(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED')),
  requested_at timestamptz NOT NULL,
  event_date_snapshot date NOT NULL,
  confirmed_at_snapshot timestamptz,
  headcount_fixed_at_snapshot timestamptz NOT NULL,
  refund_rule_code text NOT NULL CHECK (refund_rule_code IN ('BEFORE_HEADCOUNT_FIX', 'HEADCOUNT_FIX_TO_4_DAYS', '3_DAYS_TO_PREVIOUS_DAY', 'EVENT_DAY')),
  refund_rule_label text NOT NULL,
  refund_rate_percent smallint NOT NULL CHECK (refund_rate_percent IN (0, 50, 80, 100)),
  actual_paid_snapshot_won integer NOT NULL CHECK (actual_paid_snapshot_won BETWEEN 0 AND 1000000),
  refund_amount_won integer NOT NULL CHECK (refund_amount_won BETWEEN 0 AND 1000000),
  deduction_amount_won integer NOT NULL CHECK (deduction_amount_won BETWEEN 0 AND 1000000),
  policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  completed_at timestamptz,
  completed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (refund_amount_won + deduction_amount_won = actual_paid_snapshot_won),
  CHECK ((status = 'PENDING' AND completed_at IS NULL AND completed_by IS NULL)
      OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND completed_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS event_application_refund_history_app_idx
  ON public.event_application_refund_history(application_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS event_application_one_pending_refund_idx
  ON public.event_application_refund_history(application_id) WHERE status = 'PENDING';

ALTER TABLE public.event_refund_policy_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_application_refund_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_refund_policy_history, public.event_application_refund_history FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.event_refund_policy_history, public.event_application_refund_history TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.event_refund_policy_history_id_seq, public.event_application_refund_history_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.vom_event_refund_policy_update(
  p_event_id bigint, p_actor_id uuid, p_headcount_fixed_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  ev public.events%rowtype;
  setting_row public.event_payment_settings%rowtype;
  previous_fixed_at timestamptz;
  cutoff_four_days timestamptz;
BEGIN
  IF p_actor_id IS NULL OR p_headcount_fixed_at IS NULL THEN
    RAISE EXCEPTION 'invalid_headcount_fixed_at' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO ev FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found' USING ERRCODE = 'P0001'; END IF;
  cutoff_four_days := ((ev.event_date - 4)::timestamp AT TIME ZONE 'Asia/Seoul');
  IF p_headcount_fixed_at > cutoff_four_days THEN
    RAISE EXCEPTION 'headcount_fix_after_4_day_cutoff' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO setting_row FROM public.event_payment_settings WHERE event_id = p_event_id FOR UPDATE;
  previous_fixed_at := COALESCE(setting_row.headcount_fixed_at,
    ((ev.event_date - 7)::timestamp AT TIME ZONE 'Asia/Seoul'));
  INSERT INTO public.event_payment_settings(event_id, headcount_fixed_at, updated_at)
    VALUES (p_event_id, p_headcount_fixed_at, now())
    ON CONFLICT (event_id) DO UPDATE SET headcount_fixed_at = excluded.headcount_fixed_at, updated_at = excluded.updated_at;
  IF previous_fixed_at IS DISTINCT FROM p_headcount_fixed_at THEN
    INSERT INTO public.event_refund_policy_history(event_id, changed_by, before_values, after_values)
    VALUES (
      p_event_id, p_actor_id,
      jsonb_build_object('headcount_fixed_at', previous_fixed_at, 'timezone', 'Asia/Seoul', 'policy_version', '2026-11-v1'),
      jsonb_build_object('headcount_fixed_at', p_headcount_fixed_at, 'timezone', 'Asia/Seoul', 'policy_version', '2026-11-v1',
        'refund_rates', jsonb_build_array(100, 80, 50, 0))
    );
  END IF;
  RETURN jsonb_build_object('ok', true, 'headcount_fixed_at', p_headcount_fixed_at);
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
  cancel_time timestamptz;
  event_start timestamptz;
  cutoff_four_days timestamptz;
  cutoff_three_days timestamptz;
  fixed_at timestamptz;
  paid_amount integer;
  refund_rate smallint;
  refund_amount integer;
  deduction_amount integer;
  refund_code text;
  refund_label text;
  snapshot jsonb;
BEGIN
  IF p_action NOT IN ('apply', 'cancel') THEN RAISE EXCEPTION 'unsupported_application_action' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO ev FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.members WHERE id = p_member_id AND is_active AND auth_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'member_not_active' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO found_app FROM public.event_applications WHERE event_id = p_event_id AND member_id = p_member_id FOR UPDATE;
  SELECT * INTO setting FROM public.event_payment_settings WHERE event_id = p_event_id FOR SHARE;

  IF p_action = 'cancel' THEN
    IF found_app.id IS NULL OR found_app.status = 'CANCELLED' THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE = 'P0001'; END IF;
    cancel_time := clock_timestamp();
    event_start := (ev.event_date::timestamp AT TIME ZONE 'Asia/Seoul');
    cutoff_four_days := ((ev.event_date - 4)::timestamp AT TIME ZONE 'Asia/Seoul');
    cutoff_three_days := ((ev.event_date - 3)::timestamp AT TIME ZONE 'Asia/Seoul');
    fixed_at := COALESCE(setting.headcount_fixed_at, ((ev.event_date - 7)::timestamp AT TIME ZONE 'Asia/Seoul'));
    paid_amount := COALESCE(found_app.actual_paid_won,
      CASE WHEN found_app.payment_status = 'PAID' THEN found_app.final_amount_won ELSE 0 END, 0);
    IF cancel_time >= event_start THEN
      refund_rate := 0; refund_code := 'EVENT_DAY'; refund_label := '행사 당일';
    ELSIF cancel_time >= cutoff_three_days THEN
      refund_rate := 50; refund_code := '3_DAYS_TO_PREVIOUS_DAY'; refund_label := '행사 3일 전~전날';
    ELSIF cancel_time >= cutoff_four_days OR cancel_time >= fixed_at THEN
      refund_rate := 80; refund_code := 'HEADCOUNT_FIX_TO_4_DAYS'; refund_label := '인원 픽스 후~행사 4일 전';
    ELSE
      refund_rate := 100; refund_code := 'BEFORE_HEADCOUNT_FIX'; refund_label := '참석 확정 당일~인원 픽스 전날';
    END IF;
    refund_amount := round(paid_amount * refund_rate / 100.0)::integer;
    deduction_amount := paid_amount - refund_amount;
    snapshot := jsonb_build_object(
      'version', '2026-11-v1', 'timezone', 'Asia/Seoul', 'event_date', ev.event_date,
      'confirmed_at', found_app.confirmed_at, 'cancelled_at', cancel_time,
      'headcount_fixed_at', fixed_at, 'refund_rule_code', refund_code, 'refund_rule_label', refund_label,
      'refund_rate_percent', refund_rate, 'actual_paid_won', paid_amount,
      'refund_amount_won', refund_amount, 'deduction_amount_won', deduction_amount,
      'rounding', 'nearest_won'
    );
    UPDATE public.event_applications SET
      status = 'CANCELLED', cancelled_at = cancel_time, payment_status = 'REFUND_PENDING',
      refund_rule_code = refund_code, refund_rate_percent = refund_rate,
      refund_amount_won = refund_amount, refund_deduction_won = deduction_amount,
      updated_at = cancel_time
      WHERE id = found_app.id RETURNING * INTO result_app;
    INSERT INTO public.event_application_refund_history(
      application_id, event_id, member_id, status, requested_at, event_date_snapshot,
      confirmed_at_snapshot, headcount_fixed_at_snapshot, refund_rule_code, refund_rule_label,
      refund_rate_percent, actual_paid_snapshot_won, refund_amount_won, deduction_amount_won, policy_snapshot
    ) VALUES (
      result_app.id, p_event_id, p_member_id, 'PENDING', cancel_time, ev.event_date,
      found_app.confirmed_at, fixed_at, refund_code, refund_label,
      refund_rate, paid_amount, refund_amount, deduction_amount, snapshot
    );
    UPDATE public.event_coupon_redemptions SET
      status = CASE WHEN found_app.payment_status IN ('PAID', 'REFUNDED') OR found_app.status = 'CONFIRMED' THEN 'USED' ELSE 'RELEASED' END,
      used_at = CASE WHEN found_app.payment_status IN ('PAID', 'REFUNDED') OR found_app.status = 'CONFIRMED' THEN COALESCE(used_at, cancel_time) ELSE used_at END
      WHERE application_id = found_app.id AND status = 'RESERVED';
    RETURN jsonb_build_object('status', result_app.status, 'id', result_app.id, 'payment_status', result_app.payment_status,
      'cancelled_at', result_app.cancelled_at, 'refund_rule_code', refund_code, 'refund_rule_label', refund_label,
      'refund_rate_percent', refund_rate, 'actual_paid_won', paid_amount,
      'refund_amount_won', refund_amount, 'refund_deduction_won', deduction_amount);
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
      priority_participant = (pricing->>'priority_participant')::boolean, financial_locked_at = NULL,
      refund_rule_code = NULL, refund_rate_percent = NULL, refund_amount_won = NULL, refund_deduction_won = NULL,
      updated_at = now()
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

CREATE OR REPLACE FUNCTION public.vom_event_application_change(
  p_event_id bigint, p_member_id bigint, p_action text
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.vom_event_application_change(p_event_id, p_member_id, p_action, '{}'::uuid[]) $$;

CREATE OR REPLACE FUNCTION public.vom_event_refund_complete(
  p_application_id bigint, p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  app public.event_applications%rowtype;
  refund_id bigint;
  completion_time timestamptz := clock_timestamp();
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'invalid_refund_actor' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO app FROM public.event_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND OR app.status <> 'CANCELLED' OR app.payment_status <> 'REFUND_PENDING' THEN
    RAISE EXCEPTION 'refund_not_pending' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO refund_id FROM public.event_application_refund_history
    WHERE application_id = p_application_id AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF refund_id IS NULL THEN RAISE EXCEPTION 'refund_history_missing' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.event_application_refund_history
    SET status = 'COMPLETED', completed_at = completion_time, completed_by = p_actor_id
    WHERE id = refund_id;
  UPDATE public.event_applications SET payment_status = 'REFUNDED', refunded_at = completion_time,
    refunded_recorded_by = p_actor_id, updated_at = completion_time
    WHERE id = p_application_id RETURNING * INTO app;
  RETURN jsonb_build_object('ok', true, 'application_id', app.id, 'payment_status', app.payment_status,
    'refunded_at', app.refunded_at, 'refund_amount_won', app.refund_amount_won);
END;
$$;

REVOKE ALL ON FUNCTION public.vom_event_refund_policy_update(bigint,uuid,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vom_event_application_change(bigint,bigint,text,uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vom_event_application_change(bigint,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vom_event_refund_complete(bigint,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vom_event_refund_policy_update(bigint,uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.vom_event_application_change(bigint,bigint,text,uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.vom_event_application_change(bigint,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.vom_event_refund_complete(bigint,uuid) TO service_role;

