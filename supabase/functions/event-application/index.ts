import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import {
  dispatchEventMessages,
  ensureOwnEventMessagingContact,
  normalizeKoreanMobile,
  queueApplicationMessages,
  safeHttpsUrl,
} from "../_shared/event-message-outbox.ts";

const URL_ = Deno.env.get("SUPABASE_URL") || "";
const KEY_ = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const origins = ["https://thisisvom.vercel.app", "https://www.thisisvom.vercel.app"];
const headers = (origin: string) => ({
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": origins.includes(origin) ? origin : origins[0],
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  "Vary": "Origin",
});
const reply = (origin: string, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: headers(origin) });

function err(message: string, status: number): never {
  throw Object.assign(new Error(message), { status });
}

function numberId(value: unknown) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) err("올바른 일정 번호를 선택해 주세요.", 400);
  return id;
}

function errorText(error: any) {
  const detail = String(error?.message || "");
  const map: Record<string, string> = {
    applications_not_enabled: "아직 홈페이지 신청을 받지 않는 일정입니다.",
    applications_not_open: "참가 신청 오픈 전입니다.",
    applications_closed: "참가 신청이 마감됐습니다.",
    applications_full: "신청 정원이 마감됐습니다.",
    application_not_found: "취소할 참가 신청이 없습니다.",
    event_not_found: "일정을 찾을 수 없습니다.",
    member_not_active: "활동 회원만 신청할 수 있습니다.",
    refund_pending: "환불 처리 중에는 다시 신청할 수 없습니다. 운영진에게 문의해 주세요.",
  };
  return Object.entries(map).find(([key]) => detail.includes(key))?.[1] || "요청을 처리하지 못했습니다. 다시 시도해 주세요.";
}

function defaultPayment() {
  return {
    fee_won: null,
    payment_instructions: null,
    refund_instructions: null,
    payment_due_at: null,
    messaging_enabled: false,
    message_sms_fallback_enabled: false,
    confirmed_chat_url: null,
  };
}

async function applicationForMessage(service: any, eventId: number, applicationId: number) {
  const { data: application, error: appError } = await service.from("event_applications")
    .select("id,event_id,member_id,status,payment_status,applied_at,paid_at,confirmed_at,cancelled_at")
    .eq("id", applicationId).eq("event_id", eventId).maybeSingle();
  if (appError) throw appError;
  if (!application) return null;
  const { data: applicant, error: memberError } = await service.from("members")
    .select("id,name,phone").eq("id", application.member_id).maybeSingle();
  if (memberError) throw memberError;
  if (!applicant) return null;
  return { application, applicant };
}

async function notifyWithoutBlocking(
  service: any,
  kind: Parameters<typeof queueApplicationMessages>[1],
  event: any,
  payment: any,
  applicationId: number,
) {
  try {
    const data = await applicationForMessage(service, Number(event.id), applicationId);
    if (!data) return;
    await queueApplicationMessages(service, kind, event, payment, data.application, data.applicant);
    await dispatchEventMessages(service, 12);
  } catch (_) {
    // Application state is authoritative. An outbound message problem must never roll it back.
    console.error("event_message_queue_deferred");
  }
}

export async function handle(req: Request, service: any) {
  const origin = req.headers.get("Origin") || origins[0];
  if (req.headers.has("Origin") && !origins.includes(origin)) return reply(origins[0], { error: "허용되지 않은 요청입니다." }, 403);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (req.method !== "POST") return reply(origin, { error: "지원하지 않는 요청입니다." }, 405);

  try {
    const body = await req.json();
    const actions = ["view", "apply", "cancel", "admin_list", "confirm", "unconfirm", "payment_config", "mark_paid", "mark_unpaid", "refund_complete"];
    if (!actions.includes(body?.action)) err("지원하지 않는 요청입니다.", 400);
    const eventId = numberId(body.event_id);
    const token = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) err("로그인 후 이용해 주세요.", 401);
    const { data: userData, error: userError } = await service.auth.getUser(token);
    if (userError || !userData.user) err("로그인 정보를 다시 확인해 주세요.", 401);
    const userId = userData.user.id;
    const { data: member, error: me } = await service.from("members")
      .select("id,name,is_active,phone").eq("auth_user_id", userId).maybeSingle();
    if (me) throw me;
    const { data: admin, error: ae } = await service.from("admins").select("user_id").eq("user_id", userId).maybeSingle();
    if (ae) throw ae;
    const isAdmin = Boolean(admin);
    if (!member?.is_active && !isAdmin) err("가입 승인된 활동 회원만 이용할 수 있습니다.", 403);
    const { data: event, error: eventError } = await service.from("events")
      .select("id,title,event_date,start_time,location,event_type,application_enabled,application_capacity,application_opens_at,application_closes_at")
      .eq("id", eventId).maybeSingle();
    if (eventError) throw eventError;
    if (!event) err("일정을 찾을 수 없습니다.", 404);
    if (event.event_date < "2026-11-01" && !isAdmin) err("11월 이후 일정부터 신청할 수 있습니다.", 403);
    if (["admin_list", "confirm", "unconfirm", "payment_config", "mark_paid", "mark_unpaid", "refund_complete"].includes(body.action) && !isAdmin) {
      err("운영진 관리 권한이 없습니다.", 403);
    }
    const { data: paymentRecord, error: paymentError } = await service.from("event_payment_settings")
      .select("fee_won,payment_instructions,refund_instructions,payment_due_at,messaging_enabled,message_sms_fallback_enabled,confirmed_chat_url")
      .eq("event_id", eventId).maybeSingle();
    if (paymentError) throw paymentError;
    const payment = paymentRecord || defaultPayment();

    if (body.action === "payment_config") {
      if (event.event_date < "2026-11-01") err("11월 이후 일정에만 참가비를 설정할 수 있습니다.", 400);
      const fee = body.fee_won === null ? null : Number(body.fee_won);
      if (fee !== null && (!Number.isSafeInteger(fee) || fee < 0 || fee > 1000000)) {
        err("참가비는 0원(무료)부터 100만원까지 입력해 주세요.", 400);
      }
      if (payment.fee_won !== fee) {
        const { data: existing, error: existingError } = await service.from("event_applications")
          .select("id,status,payment_status").eq("event_id", eventId);
        if (existingError) throw existingError;
        if ((existing || []).some((item: any) => item.status === "CONFIRMED" || ["PAID", "REFUND_PENDING", "REFUNDED"].includes(item.payment_status))) {
          err("확정 또는 입금 내역이 있는 일정의 참가비는 변경할 수 없습니다.", 409);
        }
      }
      const instructions = String(body.payment_instructions || "").trim();
      const refundInstructions = String(body.refund_instructions || "").trim();
      if (instructions.length > 500 || refundInstructions.length > 500) err("안내 문구는 500자 이내로 작성해 주세요.", 400);
      const dueRaw = body.payment_due_at == null || body.payment_due_at === "" ? null : String(body.payment_due_at);
      if (dueRaw && (Number.isNaN(Date.parse(dueRaw)) || dueRaw.length > 40)) err("올바른 입금 기한을 입력해 주세요.", 400);
      const due = dueRaw ? new Date(dueRaw).toISOString() : null;
      const messagingEnabled = body.messaging_enabled === undefined ? Boolean(payment.messaging_enabled) : body.messaging_enabled === true;
      const fallbackEnabled = body.message_sms_fallback_enabled === undefined
        ? Boolean(payment.message_sms_fallback_enabled)
        : body.message_sms_fallback_enabled === true;
      const chatInput = body.confirmed_chat_url === undefined ? payment.confirmed_chat_url : body.confirmed_chat_url;
      let confirmedChatUrl: string | null;
      try {
        confirmedChatUrl = safeHttpsUrl(chatInput);
      } catch (error: any) {
        err(error?.message || "참가 확정 안내 링크를 다시 확인해 주세요.", 400);
      }
      const { data: saved, error: saveError } = await service.from("event_payment_settings").upsert({
        event_id: eventId,
        fee_won: fee,
        payment_instructions: instructions || null,
        refund_instructions: refundInstructions || null,
        payment_due_at: due,
        messaging_enabled: messagingEnabled,
        message_sms_fallback_enabled: fallbackEnabled,
        confirmed_chat_url: confirmedChatUrl,
        updated_at: new Date().toISOString(),
      }, { onConflict: "event_id" }).select("fee_won,payment_instructions,refund_instructions,payment_due_at,messaging_enabled,message_sms_fallback_enabled,confirmed_chat_url").single();
      if (saveError) throw saveError;
      return reply(origin, { ok: true, payment: saved });
    }

    if (["apply", "cancel"].includes(body.action)) {
      if (!member?.is_active) err("활동 회원만 신청할 수 있습니다.", 403);
      if (body.action === "apply" && payment.messaging_enabled) {
        try {
          await ensureOwnEventMessagingContact(service, member, userId, body.notification_phone, body.notification_consent);
        } catch (error: any) {
          err(error?.message || "알림 받을 휴대폰 번호를 다시 확인해 주세요.", 400);
        }
      }
      const { data, error } = await service.rpc("vom_event_application_change", {
        p_event_id: eventId,
        p_member_id: member.id,
        p_action: body.action,
      });
      if (error) return reply(origin, { error: errorText(error) }, 409);
      const kind = body.action === "apply" ? "MEMBER_APPLICATION_RECEIVED" : "MEMBER_APPLICATION_CANCELLED";
      await notifyWithoutBlocking(service, kind, event, payment, Number(data?.id));
      return reply(origin, { ok: true, ...data });
    }

    if (["mark_paid", "mark_unpaid", "refund_complete"].includes(body.action)) {
      if (body.action !== "refund_complete" && (payment.fee_won == null || payment.fee_won <= 0)) {
        err("유료 일정의 참가비 설정을 먼저 완료해 주세요.", 409);
      }
      const applicationId = numberId(body.application_id);
      const paid = body.action === "mark_paid";
      const unpaid = body.action === "mark_unpaid";
      const patch = paid
        ? { payment_status: "PAID", paid_at: new Date().toISOString(), paid_recorded_by: userId, updated_at: new Date().toISOString() }
        : unpaid
          ? { payment_status: "UNPAID", paid_at: null, paid_recorded_by: null, updated_at: new Date().toISOString() }
          : { payment_status: "REFUNDED", refunded_at: new Date().toISOString(), refunded_recorded_by: userId, updated_at: new Date().toISOString() };
      let change = service.from("event_applications").update(patch).eq("id", applicationId).eq("event_id", eventId);
      change = paid ? change.eq("status", "APPLIED").eq("payment_status", "UNPAID")
        : unpaid ? change.eq("status", "APPLIED").eq("payment_status", "PAID")
          : change.eq("status", "CANCELLED").eq("payment_status", "REFUND_PENDING");
      const { data: changed, error: changeError } = await change.select("id,status,payment_status").maybeSingle();
      if (changeError) throw changeError;
      if (!changed) err("상태가 변경돼 처리하지 못했습니다. 목록을 새로 확인해 주세요.", 409);
      if (paid) await notifyWithoutBlocking(service, "MEMBER_PAYMENT_CONFIRMED", event, payment, applicationId);
      return reply(origin, { ok: true, application: changed });
    }

    if (body.action === "confirm" || body.action === "unconfirm") {
      const applicationId = numberId(body.application_id);
      const desired = body.action === "confirm" ? "CONFIRMED" : "APPLIED";
      if (desired === "CONFIRMED" && payment.fee_won == null) err("참가비를 먼저 설정해 주세요. 무료 행사도 0원으로 설정해야 합니다.", 409);
      let update = service.from("event_applications").update({
        status: desired,
        confirmed_at: desired === "CONFIRMED" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq("id", applicationId).eq("event_id", eventId);
      update = desired === "CONFIRMED"
        ? update.eq("status", "APPLIED").eq("payment_status", payment.fee_won > 0 ? "PAID" : "UNPAID")
        : update.eq("status", "CONFIRMED");
      const { data, error } = await update.select("id,status,payment_status").maybeSingle();
      if (error) throw error;
      if (!data) err("신청 상태 또는 입금 확인 여부를 점검해 주세요.", 409);
      if (desired === "CONFIRMED") await notifyWithoutBlocking(service, "MEMBER_PARTICIPATION_CONFIRMED", event, payment, applicationId);
      return reply(origin, { ok: true, application: data });
    }

    const { data: applications, error: listError } = await service.from("event_applications")
      .select("id,member_id,status,applied_at,payment_status,paid_at,refunded_at")
      .eq("event_id", eventId).order("applied_at", { ascending: true });
    if (listError) throw listError;
    const rows = applications || [];
    const count = rows.filter((item: any) => item.status !== "CANCELLED").length;
    const mine = member ? rows.find((item: any) => Number(item.member_id) === Number(member.id)) : null;
    let preference: any = null;
    if (member) {
      const { data, error } = await service.from("member_message_preferences")
        .select("event_transaction_enabled,operator_alert_enabled").eq("member_id", member.id).maybeSingle();
      if (error) throw error;
      preference = data;
    }
    const safePayment = isAdmin || mine?.status === "CONFIRMED"
      ? payment
      : { ...payment, confirmed_chat_url: null };
    const result: any = {
      ok: true,
      event,
      payment: safePayment,
      count,
      mine: mine ? { id: mine.id, status: mine.status, payment_status: mine.payment_status } : null,
      notification: member ? {
        enabled: Boolean(payment.messaging_enabled),
        has_phone: Boolean(normalizeKoreanMobile(member.phone)),
        event_transaction_enabled: preference?.event_transaction_enabled === true,
      } : null,
      is_admin: isAdmin,
      now: new Date().toISOString(),
    };
    if (isAdmin) {
      const ids = rows.map((item: any) => item.member_id);
      const { data: people, error: peopleError } = ids.length
        ? await service.from("members").select("id,name").in("id", ids)
        : { data: [], error: null };
      if (peopleError) throw peopleError;
      const names = new Map((people || []).map((item: any) => [String(item.id), item.name]));
      result.applications = rows.map((item: any) => ({
        id: item.id,
        name: names.get(String(item.member_id)) || "회원",
        status: item.status,
        payment_status: item.payment_status,
        applied_at: item.applied_at,
        paid_at: item.paid_at,
        refunded_at: item.refunded_at,
      }));
    }
    return reply(origin, result);
  } catch (error: any) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("event_application_error", error?.name || "error");
    return reply(origin, { error: status >= 500 ? "신청 정보를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." : error.message }, status);
  }
}

if (import.meta.main) {
  Deno.serve((request) => handle(request, createClient(URL_, KEY_, { auth: { persistSession: false, autoRefreshToken: false } })));
}

