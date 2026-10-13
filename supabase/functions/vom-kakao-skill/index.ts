// VOM Kakao i Open Builder Skill API v2.0. No member or bank data is accessed.
const site = "https://thisisvom.vercel.app";
const button = (label: string, path: string) => ({ label, action: "webLink", webLinkUrl: site + path });
const quickReplies = ["행사 일정","참가 신청","입금 확인","가입 안내","운영진 문의","처음으로"].map(label => ({
  label, action: "message", messageText: label
}));
type Page = { title: string; description: string; buttons: ReturnType<typeof button>[] };
const pages: Record<string, Page> = {
  home: { title: "VOM 도우미 🎤",
    description: "VOM의 행사 일정, 참가 신청, 참가비 및 가입을 안내합니다. 개인별 정보는 홈페이지 로그인 후 확인해 주세요.",
    buttons: [button("행사 일정","/calendar/"),button("MY VOM","/me/"),button("가입 안내","/ot-room/")] },
  schedule: { title: "VOM 행사 일정 📅",
    description: "최신 일정은 캘린더에서 확인하세요. 10월 행사는 소모임, 11월 행사부터는 홈페이지 신청 방식으로 운영합니다.",
    buttons: [button("캘린더 보기","/calendar/"),button("MY VOM","/me/")] },
  apply: { title: "참가 신청 및 취소 🎫",
    description: "캘린더에서 원하는 일정을 선택하고 본인 계정으로 신청하거나 취소할 수 있습니다. 모집 오픈 시간과 정원을 확인해 주세요.",
    buttons: [button("행사 선택","/calendar/"),button("로그인하기","/me/")] },
  payment: { title: "참가비 및 입금 확인 💳",
    description: "개인별 참가비와 입금·환불 상태는 MY VOM에 로그인한 후 해당 행사 신청 화면에서 확인하세요. 채팅으로 계좌 비밀번호나 거래내역을 보내지 마세요.",
    buttons: [button("행사 선택","/calendar/"),button("MY VOM","/me/"),button("문의하기","/qna/?mine=1")] },
  join: { title: "VOM 가입 안내 👋",
    description: "홈페이지에서 가입 신청 및 OT 자료를 제출하고 운영진 검토 결과를 확인할 수 있습니다.",
    buttons: [button("가입 신청","/ot-room/"),button("가입 결과","/ot-room/?result=1")] },
  help: { title: "운영진 문의 💬",
    description: "행사, 가입, 참가비, 환불 등 자세한 문의는 홈페이지 Q&A에서 접수해 주세요. 개인 관련 문의는 로그인 후 처리합니다.",
    buttons: [button("Q&A 문의","/qna/?mine=1"),button("MY VOM","/me/")] },
  discount: { title: "운영진 음악행사 할인 🎵",
    description: "운영진은 음악행사 참가비 50% 할인 정책이 있습니다. 실제 납부액은 행사별 안내 및 운영진 확인을 거쳐 주세요. 현재 자동 할인 계산은 준비 중입니다.",
    buttons: [button("행사 확인","/calendar/"),button("운영진 문의","/qna/?mine=1")] }
};
function route(input: unknown) {
  const q = typeof input === "string" ? input.slice(0,100).replace(/\\s+/g," ") : "";
  if (/할인|반값|50%/.test(q)) return "discount";
  if (/입금|납부|회비|결제|환불|참가비/.test(q)) return "payment";
  if (/가입|OT|신규회원/.test(q)) return "join";
  if (/문의|상담|운영진|Q&A/.test(q)) return "help";
  if (/신청|취소|참가|참석/.test(q)) return "apply";
  if (/일정|달력|캘린더|라이브|버스킹|원송|ONE SONG|행사/.test(q)) return "schedule";
  return "home";
}
export function skillResponse(utterance: unknown) {
  return { version: "2.0", template: { outputs: [{ textCard: pages[route(utterance)] }], quickReplies } };
}
export async function handle(req: Request) {
  if (req.method !== "POST") return new Response("POST only",{status:405});
  try {
    if (Number(req.headers.get("content-length")||0)>16384) return new Response("Too large",{status:413});
    const raw=await req.text();
    if (raw.length>16384) return new Response("Too large",{status:413});
    const payload=JSON.parse(raw);
    const answer=skillResponse(payload?.userRequest?.utterance);
    return new Response(JSON.stringify(answer),{headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
  } catch {
    return new Response(JSON.stringify(skillResponse("")),{headers:{"Content-Type":"application/json; charset=utf-8"}});
  }
}
// Bot identity is not MY VOM authentication; this endpoint never returns private data.
if(import.meta.main) Deno.serve(handle);
