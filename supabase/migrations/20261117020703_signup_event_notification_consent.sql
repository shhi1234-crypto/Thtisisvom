-- Keep event-message consent separate from general signup terms and signup-review alerts.
ALTER TABLE public.signup_message_preferences
  ADD COLUMN IF NOT EXISTS event_transaction_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS event_transaction_consented_at timestamptz;

COMMENT ON COLUMN public.signup_message_preferences.event_transaction_enabled IS
  'Applicant opt-in for event application, payment, confirmation, and cancellation notices.';
COMMENT ON COLUMN public.signup_message_preferences.event_transaction_consented_at IS
  'Timestamp when the applicant opted in to event transaction notices.';

-- Carry only the applicant's explicit event-notice opt-in into their new member profile.
CREATE OR REPLACE FUNCTION private.vom_ot_approve_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  application public.ot_room_applicants%rowtype;
  member_key bigint;
  display_name text;
  event_notifications_enabled boolean := false;
  event_notifications_consented_at timestamptz;
BEGIN
  IF new.status <> 'APPROVED' OR new.completed_member_id IS NOT NULL THEN RETURN new; END IF;

  SELECT a.* INTO application
  FROM public.ot_room_applicants a
  JOIN public.ot_room_invites i ON i.id = a.invite_id
  WHERE i.review_id = new.id
  FOR UPDATE OF a;
  IF NOT FOUND THEN RETURN new; END IF;

  SELECT p.event_transaction_enabled, p.event_transaction_consented_at
  INTO event_notifications_enabled, event_notifications_consented_at
  FROM public.signup_message_preferences p
  WHERE p.invite_id = application.invite_id;
  event_notifications_enabled := COALESCE(event_notifications_enabled, false);
  IF NOT event_notifications_enabled THEN event_notifications_consented_at := NULL; END IF;

  PERFORM pg_advisory_xact_lock(80477001);
  SELECT id INTO member_key FROM public.members WHERE auth_user_id = application.auth_user_id;
  IF member_key IS NULL THEN
    display_name := application.somoim_nickname;
    IF EXISTS (SELECT 1 FROM public.members WHERE name = display_name) THEN
      display_name := display_name || ' · ' || left(application.auth_user_id::text, 8);
    END IF;
    INSERT INTO public.members(name,nickname,role,is_active,auth_user_id,joined_at,join_order,job,phone,region,gender,birth_date)
    VALUES(display_name,application.somoim_nickname,'모임원',true,application.auth_user_id,
      (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date,
      (SELECT coalesce(max(join_order),0)+1 FROM public.members),
      application.job,application.phone,application.region,application.gender,application.birth_date)
    RETURNING id INTO member_key;
  END IF;

  INSERT INTO public.member_account_settings(member_id,must_change_password,password_changed_at)
  VALUES(member_key,false,clock_timestamp()) ON CONFLICT(member_id) DO NOTHING;

  INSERT INTO public.member_message_preferences(
    member_id,event_transaction_enabled,event_transaction_consented_at,
    operator_alert_enabled,operator_alert_consented_at,updated_at
  ) VALUES(
    member_key,event_notifications_enabled,event_notifications_consented_at,
    false,NULL,clock_timestamp()
  ) ON CONFLICT(member_id) DO NOTHING;

  UPDATE public.ot_room_applicants SET member_id = member_key WHERE auth_user_id = application.auth_user_id;
  new.completed_member_id := member_key;
  new.completed_at := clock_timestamp();
  RETURN new;
END;
$$;

REVOKE ALL ON FUNCTION private.vom_ot_approve_member() FROM public, anon, authenticated;

