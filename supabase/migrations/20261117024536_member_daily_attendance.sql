CREATE TABLE IF NOT EXISTS public.member_daily_checkins (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  checkin_date date NOT NULL,
  checked_in_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT member_daily_checkins_member_date_key UNIQUE (member_id, checkin_date)
);

CREATE INDEX IF NOT EXISTS member_daily_checkins_date_idx
  ON public.member_daily_checkins (checkin_date DESC, member_id);

COMMENT ON TABLE public.member_daily_checkins IS
  'Member self-service daily check-ins; checkin_date is calculated in Asia/Seoul.';
COMMENT ON COLUMN public.member_daily_checkins.checkin_date IS
  'One check-in per active member per Korea Standard Time calendar date.';

ALTER TABLE public.member_daily_checkins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_daily_checkins FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.member_daily_checkins TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.member_daily_checkins_id_seq TO service_role;

