# VOM 카카오톡 채널 챗봇 · 승인 전 준비

## 현재 배포

- 챗봇 스킬: `https://aqfmhqultzpakfqwzulj.supabase.co/functions/v1/vom-kakao-skill`
- Supabase Edge Function: `vom-kakao-skill`, 스킬 응답 2.0
- 소스: `supabase/functions/vom-kakao-skill/index.ts`
- 테스트: `supabase/functions/vom-kakao-skill/index.test.ts` (배포와 별도로 실행 필요)
- GitHub 개발 브랜치: `feature/kakao-chatbot-preapproval`
- 채널 챗봇 사용 승인 및 실제 카카오 스킬 호출 테스트: 미완료

## 자동 응답 메뉴

| 입력 예시 | 응답 | 웹 링크 |
|---|---|---|
| 처음으로 | VOM 도우미 메뉴 | /calendar/, /me/, /ot-room/ |
| 행사 일정 | 캘린더 확인 안내 | /calendar/ |
| 참가 신청 | 행사 선택/본인 로그인 | /calendar/, /me/ |
| 입금 확인 | 본인 행사별 입금·환불 상태 조회 안내 | /calendar/, /me/ |
| 가입 안내 | 가입 신청 / 결과 확인 | /ot-room/ |
| 운영진 문의 | Q&A 이용 안내 | /qna/?mine=1 |
| 운영진 할인 | 음악행사 50% 할인 규정 안내, 미구현 자동 계산 유의 | /calendar/, /qna/?mine=1 |

10월까지의 기존 소모임 신청 흐름은 유지하고, 11월 일정부터 홈페이지로 연결합니다.
기존 회원 신청/입금/환불 상태는 변경하지 않습니다.

## 승인 후 오픈빌더에서 연결

1. 카카오톡 채널 챗봇 사용 권한 승인 후 챗봇 관리자센터/오픈빌더에 접속.
2. 봇을 만들고, 봇 설정에서 운영 채널 연결 조건 확인.
3. 스킬 메뉴에서 스킬을 추가하고 위 HTTPS URL을 입력.
4. 시나리오/블록에서 이 스킬을 연결하고 '스킬데이터로 사용' 응답을 선택.
5. '처음으로', '행사 일정', '참가 신청', '입금 확인', '가입 안내', '운영진 문의', '운영진 할인' 발화로 각각 테스트.
6. 운영 채널 연결과 배포는 실서비스 점검 후 진행. 승인 이전 대외 공개 또는 자동 발송 없음.

참고: [카카오 챗봇 공식 소개](https://business.kakao.com/info/chatbot/), [응답 JSON 포맷](https://kakaobusiness.gitbook.io/main/tool/chatbot/skill_guide/answer_json_format), [봇 설정](https://kakaobusiness.gitbook.io/main/tool/chatbot/main_notions/bot_setting).

## 개인정보 및 보안 경계

- 이 스킬은 정적 안내/홈페이지 링크만 제공합니다. 회원, 신청, 은행 DB 접근 없음.
- Supabase JWT 검증은 비활성화했습니다. 카카오 서버가 MY VOM JWT를 제공하지 않기 때문이며, 이 엔드포인트가 공개정보만 응답하기 때문에 가능합니다.
- 카카오 챗봇 사용자 ID는 VOM 로그인 사용자를 인증하지 않습니다.
- 개인별 신청/입금 정보는 홈페이지 본인 로그인 뒤 해당 행사에서만 확인합니다.
- 추후 채팅 내부에서 개인정보를 보여주려면 카카오 계정과 MY VOM 로그인 간 인증된 연결, 동의, 탈퇴/연결 해제, 접근 통제가 먼저 필요합니다.
- 운영진 음악행사 50% 할인은 정책 안내입니다. **현재 홈페이지에는 할인금액 자동 계산 기능이 없습니다.**
- 챗봇 서버는 채널 알림톡/친구톡/대량 발송 기능을 제공하지 않습니다.

## 테스트 예시 (승인 후 스킬 테스트)

요청:
```json
{"userRequest":{"utterance":"입금 확인"}}
```

응답은 `version: "2.0"`, `template.outputs[0].textCard`, `template.quickReplies`를 포함해야 합니다.
`textCard.buttons[*].webLinkUrl`은 VOM 사이트 경로만 사용합니다.
