import { createClient } from "@supabase/supabase-js";

const allowedOrigins = new Set([
  "https://thisisvom.vercel.app",
  "https://www.thisisvom.vercel.app",
]);
const previewOrigin = /^https:\/\/thisisvom-git-[a-z0-9-]+-projects\.vercel\.app$/;

function reply(origin: string, data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store",
      "Vary": "Origin",
    },
  });
}

function seoulDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (key: string) => parts.find((part) => part.type === key)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "https://thisisvom.vercel.app";
  if (req.headers.get("origin") && !allowedOrigins.has(origin) && !previewOrigin.test(origin)) {
    return reply(origin, { error: "허용되지 않은 요청입니다." }, 403);
  }
  if (req.method === "OPTIONS") return reply(origin, { ok: true });
  if (req.method !== "POST") return reply(origin, { error: "POST 요청만 가능합니다." }, 405);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !serviceKey) return reply(origin, { error: "서버 설정을 확인해 주세요." }, 503);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return reply(origin, { error: "요청 내용을 확인해 주세요." }, 400);
  }
  const action = String(payload.action || "status");
  if (!new Set(["status", "checkin"]).has(action)) {
    return reply(origin, { error: "지원하지 않는 요청입니다." }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(origin, { error: "로그인이 필요합니다.", code: "auth_required" }, 401);

  try {
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    const userId = auth?.user?.id;
    if (authError || !userId) return reply(origin, { error: "로그인 정보를 확인해 주세요.", code: "auth_required" }, 401);

    const { data: member, error: memberError } = await admin.from("members")
      .select("id,name,is_active")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member?.id || !member.is_active) {
      return reply(origin, { error: "활동 중인 VOM 회원 계정으로 로그인해 주세요.", code: "active_member_required" }, 403);
    }

    const today = seoulDate();
    let justCheckedIn = false;
    if (action === "checkin") {
      const { error: insertError } = await admin.from("member_daily_checkins").insert({
        member_id: member.id,
        checkin_date: today,
      });
      if (insertError && insertError.code !== "23505") throw insertError;
      justCheckedIn = !insertError;
    }

    const { data: existing, error: statusError } = await admin.from("member_daily_checkins")
      .select("id,checked_in_at")
      .eq("member_id", member.id)
      .eq("checkin_date", today)
      .maybeSingle();
    if (statusError) throw statusError;

    return reply(origin, {
      ok: true,
      today,
      checked_in: Boolean(existing),
      just_checked_in: justCheckedIn,
      checked_in_at: existing?.checked_in_at || null,
      member_name: String(member.name || "회원"),
    });
  } catch (error) {
    console.error("member attendance request failed", error instanceof Error ? error.message : error);
    return reply(origin, { error: "출석 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
});

