import {handle, skillResponse} from "./index.ts";

Deno.test("Kakao skill response uses version 2.0 and valid menu", () => {
  const result = skillResponse("");
  if (result.version !== "2.0") throw new Error("version");
  if (result.template.outputs.length !== 1) throw new Error("outputs");
  if (result.template.quickReplies.length > 10) throw new Error("quick replies");
  const card = result.template.outputs[0].textCard;
  if (card.buttons.length > 3) throw new Error("too many buttons");
});

Deno.test("All expected menu intents route safely", () => {
  for (const [query, title] of [
    ["행사 일정", "행사 일정"], ["참가 신청", "신청"],
    ["입금 확인", "입금"], ["가입 안내", "가입"],
    ["운영진 문의", "문의"], ["운영진 할인", "할인"]
  ]) {
    const result = skillResponse(query);
    const card = result.template.outputs[0].textCard;
    if (!card.title.includes(title)) throw new Error(query + " routed incorrectly");
    if (card.buttons.some(b => !b.webLinkUrl.startsWith("https://thisisvom.vercel.app/")))
      throw new Error("unexpected outbound link");
  }
});

Deno.test("Does not reveal member payment status in chat", () => {
  const card = skillResponse("내 입금 상태").template.outputs[0].textCard;
  if (!card.description.includes("로그인")) throw new Error("login guidance required");
  if (JSON.stringify(card).includes("계좌번호")) throw new Error("bank data leak");
});

Deno.test("Kakao POST payload returns menu", async () => {
  const req = new Request("https://example.com/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userRequest: { utterance: "가입 안내", user: { id: "UNTRUSTED" } } })
  });
  const res = await handle(req);
  const body = await res.json();
  if (res.status !== 200 || !body.template.outputs[0].textCard.title.includes("가입"))
    throw new Error("POST response invalid");
  if (JSON.stringify(body).includes("UNTRUSTED")) throw new Error("echoed unverified user ID");
});

Deno.test("Non-POST methods are rejected", async () => {
  if ((await handle(new Request("https://example.com/"))).status !== 405)
    throw new Error("GET must be rejected");
});
