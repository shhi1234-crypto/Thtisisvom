-- Keep temporary end-to-end test schedules invisible to other members.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS is_test_only boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS test_member_id bigint REFERENCES public.members(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.events.is_test_only IS
  'When true, only admins and the assigned test member may view or apply to this schedule.';
COMMENT ON COLUMN public.events.test_member_id IS
  'The one active member allowed to view and use a test-only schedule. NULL keeps it admin-only.';

CREATE OR REPLACE FUNCTION private.vom_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.admins a WHERE a.user_id = (SELECT auth.uid())
  );
$function$;

CREATE OR REPLACE FUNCTION private.vom_can_view_event(p_event_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.events e
    WHERE e.id = p_event_id
      AND (
        (
          e.is_test_only IS NOT TRUE
          AND (
            ((SELECT auth.uid()) IS NOT NULL AND private.vom_is_approved())
            OR (
              e.event_date < (current_timestamp AT TIME ZONE 'Asia/Seoul')::date
              AND (
                e.event_type IN ('VOM LIVE', 'BUSKING', 'OPEN MIC')
                OR (
                  e.event_type = 'OTHER'
                  AND (upper(e.title) LIKE '%OPEN MIC%' OR e.title LIKE '%대관공연%')
                )
              )
            )
          )
        )
        OR (
          e.is_test_only IS TRUE
          AND (
            private.vom_is_admin()
            OR (
              (SELECT auth.uid()) IS NOT NULL
              AND private.vom_is_approved()
              AND e.test_member_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM public.members m
                WHERE m.auth_user_id = (SELECT auth.uid())
                  AND m.id = e.test_member_id
                  AND m.is_active IS TRUE
              )
            )
          )
        )
      )
  );
$function$;

DROP POLICY IF EXISTS "approved members read schedule" ON public.events;
CREATE POLICY "approved members read schedule"
ON public.events
FOR SELECT
TO authenticated
USING (
  private.vom_is_approved()
  AND (is_test_only IS NOT TRUE OR private.vom_can_view_event(id))
);

