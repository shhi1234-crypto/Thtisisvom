// Kakao Open Builder VOM bot: public information only.
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  return new Response(JSON.stringify({
    version: "2.0",
    template: { outputs: [{ simpleText: { text: "VOM 챗봇 준비 중입니다. 홈페이지에서 행사 일정과 가입 절차를 확인해 주세요. https://thisisvom.vercel.app/calendar/" } }] }
  }), { headers: { "Content-Type": "application/json" } });
});
