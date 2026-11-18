CREATE INDEX IF NOT EXISTS events_test_member_id_idx
  ON public.events(test_member_id)
  WHERE is_test_only IS TRUE AND test_member_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.seed_event_operation_tasks()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF NEW.is_test_only IS TRUE OR NEW.event_date IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.event_type = 'BUSKING' THEN
    INSERT INTO public.event_operation_tasks
      (event_id, task_key, title, description, due_date, sort_order)
    VALUES
      (NEW.id, 'venue-confirm', '장소·대관 확정 확인', '신청·확정 여부와 장소 사용 조건을 확인합니다.', NEW.event_date - 35, 10),
      (NEW.id, 'somoim-open', '소모임 모집글 작성·오픈', '회원은 기존처럼 소모임에서 바로 신청합니다. VOM에는 별도 신청 절차를 만들지 않습니다.', NEW.event_date - 21, 20),
      (NEW.id, 'application-close', '참가 신청 마감·인원 확정', '공연 전주 금요일에 참가 신청을 마감하고 인원을 확정합니다.', NEW.event_date - (((EXTRACT(dow FROM NEW.event_date)::integer + 6) % 7) + 3), 30),
      (NEW.id, 'setlist-deadline', '셋리스트·MR 마감', '공연 5일 전까지 셋리스트와 MR을 최종 입력·확인합니다.', NEW.event_date - 5, 35),
      (NEW.id, 'final-notice', '최종 공지·준비물 확인', '집결, 장비, 촬영 등 행사별 준비사항을 최종 확인합니다.', NEW.event_date - 3, 40),
      (NEW.id, 'event-day', '당일 운영 체크', '담당자, 장비, 진행 순서와 현장 전달사항을 확인합니다.', NEW.event_date, 50)
    ON CONFLICT (event_id, task_key) DO NOTHING;
  ELSE
    INSERT INTO public.event_operation_tasks
      (event_id, task_key, title, description, due_date, sort_order)
    VALUES
      (NEW.id, 'venue-confirm', '장소·대관 확정 확인', '신청·확정 여부와 장소 사용 조건을 확인합니다.', NEW.event_date - 35, 10),
      (NEW.id, 'somoim-open', '소모임 모집글 작성·오픈', '회원은 기존처럼 소모임에서 바로 신청합니다. VOM에는 별도 신청 절차를 만들지 않습니다.', NEW.event_date - 21, 20),
      (NEW.id, 'participants-confirm', '참가 마감·명단 확인', '소모임 참석 인원과 실제 참가 가능 여부를 확인합니다.', NEW.event_date - 7, 30),
      (NEW.id, 'final-notice', '최종 공지·준비물 확인', '집결, 장비, 준비물 등 행사별 준비사항을 최종 확인합니다.', NEW.event_date - 3, 40),
      (NEW.id, 'event-day', '당일 운영 체크', '담당자, 장비, 진행 순서와 현장 전달사항을 확인합니다.', NEW.event_date, 50)
    ON CONFLICT (event_id, task_key) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;

