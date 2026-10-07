import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { issueActivation } from "../_shared/member-access.ts";
import webpush from "npm:web-push@3.6.7";

const allowedOrigins = new Set([
  "https://thisisvom.vercel.app",
  "https://www.thisisvom.vercel.app"
]);

function response(body: Record<string, unknown>, status = 200, origin = "https://thisisvom.vercel.app") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store"
    }
  });
}

function asMemberId(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/* Supabase Auth 최소 길이와 별개로, VOM 화면에서는 4자리 개인 비밀번호를 쓸 수 있게 합니다. */
function authPassword(value: unknown) {
  return "VOM:" + String(value ?? "");
}

async function requireSignedInUser(req: Request, admin: any) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) throw new Error("로그인이 필요합니다.");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Error("로그인 정보를 확인하지 못했습니다.");
  return data.user;
}

async function requireAdminUser(req: Request, admin: any) {
  const user = await requireSignedInUser(req, admin);
  const { data: adminRow, error } = await admin
    .from("admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (!adminRow) throw new Error("운영진만 사용할 수 있습니다.");
  return user;
}


const CONSULTATION_CATEGORIES = new Set([
  "VOM 이용안내",
  "모임 참여",
  "공연·버스킹",
  "일정",
  "참가비·환불",
  "기타 문의"
]);
const QNA_QUESTION_SELECT = "id,member_id,category,title,content,status,is_public,is_anonymous,channel,operator_notified_at,created_at,updated_at,vom_qna_answers(id,content,is_public,created_at,updated_at)";

async function requireLinkedMember(req: Request, admin: any) {
  const user = await requireSignedInUser(req, admin);
  const { data: member, error } = await admin
    .from("members")
    .select("id,name,nickname")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (!member?.id) throw new Error("MY VOM 로그인 회원을 찾지 못했습니다.");
  return member;
}

async function sendInquiryPush(admin: any, question: any, memberName: string) {
  const { data: config, error: configError } = await admin
    .from("vom_push_config")
    .select("vapid_public_key,vapid_private_key,subject")
    .eq("id", 1)
    .maybeSingle();
  if (configError || !config) return { sent: 0, skipped: true };

  const { data: subscriptions, error: subscriptionError } = await admin
    .from("vom_push_subscriptions")
    .select("id,endpoint,p256dh,auth")
    .eq("is_active", true);
  if (subscriptionError || !(subscriptions || []).length) return { sent: 0, skipped: true };

  webpush.setVapidDetails(
    config.subject,
    config.vapid_public_key,
    config.vapid_private_key
  );

  const body = String(question.category || "기타 문의") + " · " +
    String(memberName || "회원") + "님이 문의를 남겼어요.";
  let sent = 0;
  for (const subscription of subscriptions || []) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth }
        },
        JSON.stringify({
          title: "새 VOM 문의 1건",
          body,
          url: "https://thisisvom.vercel.app/admin-settings/#inquiries",
          tag: "vom-inquiry-" + String(question.id)
        }),
        { TTL: 3600 }
      );
      sent++;
    } catch (sendError: any) {
      const statusCode = Number(sendError?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) {
        await admin
          .from("vom_push_subscriptions")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", subscription.id);
      }
      console.error("inquiry push failed", sendError?.message || sendError);
    }
  }
  return { sent };
}

async function markInquiryNotified(admin: any, inquiryId: number) {
  const { error } = await admin
    .from("vom_qna_questions")
    .update({ operator_notified_at: new Date().toISOString() })
    .eq("id", inquiryId);
  if (error) console.error("inquiry notification timestamp failed", error);
}

Deno.serve(async (req) => {
  const requestOrigin = req.headers.get("origin") || "https://thisisvom.vercel.app";
  if (req.headers.get("origin") && !allowedOrigins.has(requestOrigin)) {
    return response({ error: "허용되지 않은 요청입니다." }, 403, requestOrigin);
  }
  if (req.method === "OPTIONS") return response({ ok: true }, 200, requestOrigin);
  if (req.method !== "POST") return response({ error: "POST 요청만 가능합니다." }, 405, requestOrigin);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return response({ error: "서버 설정을 확인해 주세요." }, 500, requestOrigin);

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return response({ error: "요청 내용을 읽지 못했습니다." }, 400, requestOrigin);
  }

  const action = String(payload.action || "");

  try {
    if (action === "hint") {
      const memberId = asMemberId(payload.member_id);
      if (!memberId) return response({ error: "회원을 선택해 주세요." }, 400, requestOrigin);

      const [{ data: member, error: memberError }, { data: setting, error: settingError }] = await Promise.all([
        admin.from("members").select("id,name,auth_user_id").eq("id", memberId).maybeSingle(),
        admin.from("member_account_settings").select("password_hint").eq("member_id", memberId).maybeSingle()
      ]);
      if (memberError || settingError) throw memberError || settingError;
      const hintUser = await requireSignedInUser(req, admin);
      if (!member || member.auth_user_id !== hintUser.id) return response({ error: "본인의 힌트만 확인할 수 있습니다." }, 403, requestOrigin);
      if (!member?.auth_user_id) return response({ ready: false, hint: "", message: "아직 개인 설정이 시작되지 않았어요." }, 200, requestOrigin);
      return response({
        ready: true,
        hint: setting?.password_hint || "",
        message: setting?.password_hint ? "등록된 힌트입니다." : "등록된 비밀번호 힌트가 없습니다."
      }, 200, requestOrigin);
    }

    if (action === "setup") {
      return response({ error: "개인 설정은 운영진이 본인에게 발급한 개인 링크에서 진행해 주세요." }, 403, requestOrigin);
    }

    if (action === "whoami") {
      const user = await requireSignedInUser(req, admin);
      const { data: member, error } = await admin
        .from("members")
        .select("id,name,nickname,role,region,favorite_singers,job")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (error) throw error;
      return response({ member_id: member?.id || null, member: member || null }, 200, requestOrigin);
    }

    if (action === "consultation_list") {
      const member = await requireLinkedMember(req, admin);
      const { data, error } = await admin
        .from("vom_qna_questions")
        .select(QNA_QUESTION_SELECT)
        .eq("member_id", member.id)
        .order("created_at", { ascending: false });
      if (error) throw error;

      for (const inquiry of data || []) {
        const isWaiting = inquiry.status === "신규" || inquiry.status === "대기";
        if (inquiry.channel !== "CONSULTATION" || !isWaiting || inquiry.operator_notified_at) continue;
        const push = await sendInquiryPush(
          admin,
          inquiry,
          String(member.name || member.nickname || "회원")
        ).catch((pushError) => {
          console.error("missed inquiry push failed", pushError);
          return { sent: 0 };
        });
        if (Number(push.sent || 0) > 0) {
          await markInquiryNotified(admin, Number(inquiry.id));
        }
      }

      return response({ inquiries: data || [] }, 200, requestOrigin);
    }

    if (action === "consultation_create") {
      const member = await requireLinkedMember(req, admin);
      const category = String(payload.category || "").trim();
      const content = String(payload.content || "").trim();
      const isPublic = payload.is_public === true;

      if (!CONSULTATION_CATEGORIES.has(category)) {
        return response({ error: "문의 유형을 선택해 주세요." }, 400, requestOrigin);
      }
      if (content.length < 2 || content.length > 3000) {
        return response({ error: "문의 내용은 2~3,000자로 입력해 주세요." }, 400, requestOrigin);
      }

      const normalized = content.replace(/\s+/g, " ");
      const title = ("[" + category + "] " + normalized.slice(0, 72)).slice(0, 100);
      const { data: inquiry, error } = await admin
        .from("vom_qna_questions")
        .insert({
          member_id: member.id,
          category,
          title,
          content,
          status: "신규",
          channel: "CONSULTATION",
          is_public: isPublic,
          is_anonymous: false
        })
        .select(QNA_QUESTION_SELECT)
        .single();
      if (error) throw error;

      const push = await sendInquiryPush(
        admin,
        inquiry,
        String(member.name || member.nickname || "회원")
      ).catch((pushError) => {
        console.error("inquiry push setup failed", pushError);
        return { sent: 0, skipped: true };
      });
      if (Number(push.sent || 0) > 0) {
        await markInquiryNotified(admin, Number(inquiry.id));
      }

      return response({ ok: true, inquiry, operator_push: push }, 200, requestOrigin);
    }

    if (action === "admin_members_list") {
      await requireAdminUser(req, admin);
      const { data, error } = await admin
        .from("members")
        .select("*")
        .order("join_order", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return response({ members: data || [] }, 200, requestOrigin);
    }

    if (action === "admin_member_save") {
      await requireAdminUser(req, admin);
      const memberId = asMemberId(payload.member_id);
      const input = payload.fields && typeof payload.fields === "object"
        ? payload.fields as Record<string, unknown>
        : {};
      const allowed = new Set([
        "name","nickname","profile_image_url","joined_at","is_active","note",
        "role","birth_date","region","gender","favorite_singers","join_order",
        "phone","instagram","memo","job"
      ]);
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        if (allowed.has(key)) fields[key] = value;
      }
      if (!String(fields.name || "").trim()) {
        return response({ error: "이름을 입력해 주세요." }, 400, requestOrigin);
      }

      if (memberId) {
        const { data, error } = await admin
          .from("members")
          .update(fields)
          .eq("id", memberId)
          .select("*")
          .single();
        if (error) throw error;
        return response({ ok: true, member: data }, 200, requestOrigin);
      }

      const { data, error } = await admin
        .from("members")
        .insert(fields)
        .select("*")
        .single();
      if (error) throw error;
      return response({ ok: true, member: data }, 200, requestOrigin);
    }

    if (action === "admin_member_delete") {
      await requireAdminUser(req, admin);
      const memberId = asMemberId(payload.member_id);
      if (!memberId) return response({ error: "회원을 선택해 주세요." }, 400, requestOrigin);
      const { error } = await admin.from("members").delete().eq("id", memberId);
      if (error) throw error;
      return response({ ok: true }, 200, requestOrigin);
    }

    if (action === "admin_reset") {
      const memberId = asMemberId(payload.member_id);
      if (!memberId) return response({ error: "회원을 선택해 주세요." }, 400, requestOrigin);

      const authHeader = req.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!token) return response({ error: "운영진 로그인이 필요합니다." }, 401, requestOrigin);

      const { data: userData, error: userError } = await admin.auth.getUser(token);
      if (userError || !userData.user) return response({ error: "운영진 로그인을 확인하지 못했습니다." }, 401, requestOrigin);

      const { data: adminRow, error: adminError } = await admin
        .from("admins")
        .select("user_id")
        .eq("user_id", userData.user.id)
        .maybeSingle();
      if (adminError) throw adminError;
      if (!adminRow) return response({ error: "운영진만 초기화할 수 있습니다." }, 403, requestOrigin);

      const { data: member, error: memberError } = await admin
        .from("members")
        .select("id,name,auth_user_id")
        .eq("id", memberId)
        .maybeSingle();
      if (memberError) throw memberError;
      if (!member) return response({ error: "회원 정보를 확인해 주세요." }, 404, requestOrigin);
      const activation = await issueActivation(admin, member.id, userData.user.id);
      return response({ ok: true, member_name: member.name || "", ...activation }, 200, requestOrigin);
    }

    return response({ error: "지원하지 않는 요청입니다." }, 400, requestOrigin);
  } catch (error) {
    console.error(error);
    return response({ error: error instanceof Error ? error.message : "처리 중 오류가 발생했습니다." }, 500, requestOrigin);
  }
});
