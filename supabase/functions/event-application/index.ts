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
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-supabase-api-version",
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

function couponIds(value: unknown) {
  if (value == null) return [] as string[];
  if (!Array.isArray(value) || value.length > 4 || value.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    err("적용할 쿠폰을 다시 선택해 주세요.", 400);
  }
  return value as string[];
}

function couponValue(body: any) {
  const type = String(body?.coupon_type || "");
  if (!["FIXED", "PERCENT", "FULL", "PRIORITY"].includes(type)) err("쿠폰 유형을 선택해 주세요.", 400);
  const value = type === "FIXED" || type === "PERCENT" ? Number(body.value) : null;
  if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > (type === "PERCENT" ? 100 : 1000000))) {
    err(type === "PERCENT" ? "비율 쿠폰은 1~100%로 입력해 주세요." : "정액 쿠폰은 1원부터 100만원까지 입력해 주세요.", 400);
  }
  const title = String(body.title || "").trim();
  if (!title || title.length > 100) err("쿠폰 이름을 1~100자로 입력해 주세요.", 400);
  const validFrom = body.valid_from ? new Date(String(body.valid_from)) : new Date();
  const expiresAt = body.expires_at ? new Date(String(body.expires_at)) : null;
  if (Number.isNaN(validFrom.getTime()) || (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= validFrom))) {
    err("쿠폰 유효기간을 확인해 주세요.", 400);
  }
  return { type, value, title, validFrom: validFrom.toISOString(), expiresAt: expiresAt?.toISOString() || null };
}

function defaultHeadcountFixedAt(eventDate: string) {
  const date = new Date(`${eventDate}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() - 7);
  return date.toISOString();
}

function errorText(error: any) {
  const detail = String(error?.message || "");
  const map: Record<string, string> = {
    applications_not_enabled: "아직 홈페이지 신청을 받지 않는 일정입니다.",
    applications_not_open: "참가 신청 오픈 전입니다.",
    applications_closed: "참가 신청이 마감됐습니다.",
    applications_full: "신청 정원이 마감됐습니다.",
    event_fee_not_configured: "운영진이 참가비를 아직 설정하지 않았습니다.",
    coupon_not_available: "선택한 쿠폰의 사용 기간, 일정 또는 회원 조건을 확인해 주세요.",
    coupon_already_used: "이미 사용한 쿠폰이 포함되어 있습니다.",
    coupon_not_stackable: "함께 사용할 수 없는 쿠폰이 포함되어 있습니다. 쿠폰은 한 장씩 선택해 주세요.",
    coupon_not_found: "선택한 쿠폰을 찾을 수 없습니다.",
    application_not_found: "취소할 참가 신청이 없습니다.",
    event_not_found: "일정을 찾을 수 없습니다.",
    member_not_active: "활동 회원만 신청할 수 있습니다.",
    refund_pending: "환불 처리 중에는 다시 신청할 수 없습니다. 운영진에게 문의해 주세요.",
    headcount_fix_after_4_day_cutoff: "인원 픽스 시각은 행사 4일 전 00:00(한국 시간) 이전으로 설정해 주세요.",
    invalid_headcount_fixed_at: "인원 픽스 시각을 한국 시간 기준으로 다시 확인해 주세요.",
    refund_financial_locked: "취소 접수 후에는 환불 계산이 고정되어 금액을 변경할 수 없습니다.",
    refund_not_pending: "환불 대기 상태의 신청 내역이 아닙니다.",
    refund_history_missing: "환불 계산 기록을 찾지 못했습니다. 신청 내역을 새로고침해 주세요.",
    duplicate_coupon: "같은 쿠폰을 중복 선택했습니다.",
    too_many_coupons: "한 번에 선택할 수 있는 쿠폰은 최대 4장입니다.",
  };
  return Object.entries(map).find(([key]) => detail.includes(key))?.[1] || "요청을 처리하지 못했습니다. 다시 시도해 주세요.";
}

function defaultPayment(eventDate?: string) {
  return {
    fee_won: null,
    payment_instructions: null,
    refund_instructions: null,
    payment_due_at: null,
    headcount_fixed_at: eventDate ? defaultHeadcountFixedAt(eventDate) : null,
    messaging_enabled: false,
    message_sms_fallback_enabled: false,
    confirmed_chat_url: null,
  };
}

async function applicationForMessage(service: any, eventId: number, applicationId: number) {
  const { data: application, error: appError } = await service.from("event_applications")
    .select("id,event_id,member_id,status,payment_status,applied_at,paid_at,confirmed_at,cancelled_at,final_amount_won,actual_paid_won,refund_rule_code,refund_rate_percent,refund_amount_won,refund_deduction_won")
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
    const actions = ["view", "my_applications", "apply", "cancel", "admin_list", "confirm", "unconfirm", "payment_config", "mark_paid", "mark_unpaid", "refund_complete", "financial_update", "coupon_create", "coupon_update"];
    if (!actions.includes(body?.action)) err("지원하지 않는 요청입니다.", 400);
    const eventId = body.action === "my_applications" ? null : numberId(body.event_id);
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
    if (body.action === "my_applications") {
      if (!member?.is_active) err("회원 계정으로 로그인해 주세요.", 403);
      const { data: applications, error: appError } = await service.from("event_applications")
        .select("id,event_id,status,payment_status,applied_at,confirmed_at,cancelled_at,base_fee_won,applied_coupons_snapshot,discount_amount_won,final_amount_won,actual_paid_won,priority_participant,financial_locked_at,refund_rule_code,refund_rate_percent,refund_amount_won,refund_deduction_won")
        .eq("member_id", member.id).order("applied_at", { ascending: false }).limit(30);
      if (appError) throw appError;
      const eventIds = [...new Set((applications || []).map((item: any) => Number(item.event_id)))];
      const { data: events, error: eventsError } = eventIds.length
        ? await service.from("events").select("id,title,event_date,start_time,location").in("id", eventIds)
        : { data: [], error: null };
      if (eventsError) throw eventsError;
      const byId = new Map((events || []).map((item: any) => [Number(item.id), item]));
      return reply(origin, { ok: true, applications: (applications || []).map((item: any) => ({ ...item, event: byId.get(Number(item.event_id)) || null })) });
    }
    const currentEventId = eventId as number;
    const { data: event, error: eventError } = await service.from("events")
      .select("id,title,event_date,start_time,location,event_type,application_enabled,application_capacity,application_opens_at,application_closes_at")
      .eq("id", currentEventId).maybeSingle();
    if (eventError) throw eventError;
    if (!event) err("일정을 찾을 수 없습니다.", 404);
    if (event.event_date < "2026-11-01" && !isAdmin) err("11월 이후 일정부터 신청할 수 있습니다.", 403);
    if (["admin_list", "confirm", "unconfirm", "payment_config", "mark_paid", "mark_unpaid", "refund_complete", "financial_update", "coupon_create", "coupon_update"].includes(body.action) && !isAdmin) {
      err("운영진 관리 권한이 없습니다.", 403);
    }
    const { data: paymentRecord, error: paymentError } = await service.from("event_payment_settings")
      .select("fee_won,payment_instructions,refund_instructions,payment_due_at,headcount_fixed_at,messaging_enabled,message_sms_fallback_enabled,confirmed_chat_url")
      .eq("event_id", currentEventId).maybeSingle();
    if (paymentError) throw paymentError;
    const payment = paymentRecord || defaultPayment(event.event_date);

    if (body.action === "payment_config") {
      if (event.event_date < "2026-11-01") err("11월 이후 일정에만 참가비를 설정할 수 있습니다.", 400);
      const fee = body.fee_won === null ? null : Number(body.fee_won);
      if (fee !== null && (!Number.isSafeInteger(fee) || fee < 0 || fee > 1000000)) {
        err("참가비는 0원(무료)부터 100만원까지 입력해 주세요.", 400);
      }
      const instructions = String(body.payment_instructions || "").trim();
      const refundInstructions = String(body.refund_instructions || "").trim();
      if (instructions.length > 500 || refundInstructions.length > 500) err("안내 문구는 500자 이내로 작성해 주세요.", 400);
      const dueRaw = body.payment_due_at == null || body.payment_due_at === "" ? null : String(body.payment_due_at);
      if (dueRaw && (Number.isNaN(Date.parse(dueRaw)) || dueRaw.length > 40)) err("올바른 입금 기한을 입력해 주세요.", 400);
      const due = dueRaw ? new Date(dueRaw).toISOString() : null;
      const headcountRaw = body.headcount_fixed_at == null || body.headcount_fixed_at === ""
        ? String(payment.headcount_fixed_at || defaultHeadcountFixedAt(event.event_date))
        : String(body.headcount_fixed_at);
      const headcountDateValue = /^\d{4}-\d{2}-\d{2}$/.test(headcountRaw) ? `${headcountRaw}T00:00:00+09:00` : headcountRaw;
      const headcountDate = new Date(headcountDateValue);
      if (Number.isNaN(headcountDate.getTime()) || headcountRaw.length > 40) err("인원 픽스 시각을 한국 시간 기준으로 다시 확인해 주세요.", 400);
      const headcountFixedAt = headcountDate.toISOString();
      const { error: policyError } = await service.rpc("vom_event_refund_policy_update", {
        p_event_id: currentEventId,
        p_actor_id: userId,
        p_headcount_fixed_at: headcountFixedAt,
      });
      if (policyError) {
        if (String(policyError.message).includes("headcount_fix_after_4_day_cutoff")) err(errorText(policyError), 400);
        if (String(policyError.message).includes("invalid_headcount_fixed_at")) err(errorText(policyError), 400);
        throw policyError;
      }
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
        event_id: currentEventId,
        fee_won: fee,
        payment_instructions: instructions || null,
        refund_instructions: refundInstructions || null,
        payment_due_at: due,
        headcount_fixed_at: headcountFixedAt,
        messaging_enabled: messagingEnabled,
        message_sms_fallback_enabled: fallbackEnabled,
        confirmed_chat_url: confirmedChatUrl,
        updated_at: new Date().toISOString(),
      }, { onConflict: "event_id" }).select("fee_won,payment_instructions,refund_instructions,payment_due_at,headcount_fixed_at,messaging_enabled,message_sms_fallback_enabled,confirmed_chat_url").single();
      if (saveError) throw saveError;
      return reply(origin, { ok: true, payment: saved });
    }

    if (body.action === "coupon_create" || body.action === "coupon_update") {
      if (event.event_date < "2026-11-01") err("11월 이후 일정에만 쿠폰을 설정할 수 있습니다.", 400);
      const config = couponValue(body);
      const rawMember = body.allowed_member_id == null || body.allowed_member_id === "" ? null : Number(body.allowed_member_id);
      if (rawMember !== null && (!Number.isSafeInteger(rawMember) || rawMember <= 0)) err("사용 가능 회원을 다시 선택해 주세요.", 400);
      if (rawMember !== null) {
        const { data: targetMember, error: targetError } = await service.from("members").select("id,is_active").eq("id", rawMember).maybeSingle();
        if (targetError) throw targetError;
        if (!targetMember?.is_active) err("활동 중인 회원에게만 쿠폰을 발급할 수 있습니다.", 400);
      }
      if (config.type === "PRIORITY" && rawMember === null) err("우선 참가권은 사용할 회원을 지정해 운영진이 발급해 주세요.", 400);
      if (config.type === "PRIORITY" && body.one_time === false) err("우선 참가권은 지정 회원이 한 번 사용할 수 있도록 발급해 주세요.", 400);
      const patch = {
        title: config.title,
        coupon_type: config.type,
        value: config.value,
        allowed_event_id: currentEventId,
        allowed_member_id: rawMember,
        valid_from: config.validFrom,
        expires_at: config.expiresAt,
        one_time: body.one_time !== false,
        stackable: body.stackable === true,
        is_active: body.is_active !== false,
        updated_at: new Date().toISOString(),
      };
      if (body.action === "coupon_create") {
        const { data: created, error: createError } = await service.from("event_coupons")
          .insert({ ...patch, issued_by: userId }).select("id,title,coupon_type,value,allowed_event_id,allowed_member_id,valid_from,expires_at,one_time,stackable,is_active,created_at").single();
        if (createError) throw createError;
        return reply(origin, { ok: true, coupon: created });
      }
      const couponId = String(body.coupon_id || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(couponId)) err("쿠폰을 다시 선택해 주세요.", 400);
      const { data: updated, error: updateError } = await service.from("event_coupons").update(patch)
        .eq("id", couponId).eq("allowed_event_id", currentEventId)
        .select("id,title,coupon_type,value,allowed_event_id,allowed_member_id,valid_from,expires_at,one_time,stackable,is_active,created_at").maybeSingle();
      if (updateError) throw updateError;
      if (!updated) err("수정할 쿠폰을 찾지 못했습니다.", 404);
      return reply(origin, { ok: true, coupon: updated });
    }

    if (body.action === "financial_update") {
      const applicationId = numberId(body.application_id);
      const baseFee = Number(body.base_fee_won);
      if (!Number.isSafeInteger(baseFee) || baseFee < 0 || baseFee > 1000000) err("기본 참가비는 0원부터 100만원까지 입력해 주세요.", 400);
      const actualRaw = body.actual_paid_won == null || body.actual_paid_won === "" ? null : Number(body.actual_paid_won);
      if (actualRaw !== null && (!Number.isSafeInteger(actualRaw) || actualRaw < 0 || actualRaw > 1000000)) err("실제 입금액은 0원부터 100만원까지 입력해 주세요.", 400);
      const reason = String(body.reason || "").trim() || null;
      const { data, error } = await service.rpc("vom_event_application_financial_update", {
        p_application_id: applicationId,
        p_actor_id: userId,
        p_base_fee_won: baseFee,
        p_coupon_ids: couponIds(body.coupon_ids),
        p_actual_paid_won: actualRaw,
        p_reason: reason,
      });
      if (error) {
        if (String(error.message).includes("financial_locked_reason_required")) err("입금 확인 또는 참가 확정 후의 금액 변경에는 사유가 필요합니다.", 409);
        if (String(error.message).includes("refund_financial_locked")) err(errorText(error), 409);
        if (String(error.message).includes("coupon_")) err("쿠폰 조건을 확인해 주세요. 이미 사용했거나 이 일정·회원에 적용할 수 없는 쿠폰일 수 있습니다.", 409);
        throw error;
      }
      return reply(origin, data);
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
        p_event_id: currentEventId,
        p_member_id: member.id,
        p_action: body.action,
        p_coupon_ids: body.action === "apply" ? couponIds(body.coupon_ids) : [],
      });
      if (error) return reply(origin, { error: errorText(error) }, 409);
      const kind = body.action === "apply" ? "MEMBER_APPLICATION_RECEIVED" : "MEMBER_APPLICATION_CANCELLED";
      await notifyWithoutBlocking(service, kind, event, payment, Number(data?.id));
      return reply(origin, { ok: true, ...data });
    }

    if (body.action === "refund_complete") {
      const applicationId = numberId(body.application_id);
      const { data, error } = await service.rpc("vom_event_refund_complete", {
        p_application_id: applicationId,
        p_actor_id: userId,
      });
      if (error) {
        if (String(error.message).includes("refund_not_pending")) err(errorText(error), 409);
        if (String(error.message).includes("refund_history_missing")) err(errorText(error), 409);
        throw error;
      }
      return reply(origin, data);
    }

    if (["mark_paid", "mark_unpaid"].includes(body.action)) {
      const applicationId = numberId(body.application_id);
      const paid = body.action === "mark_paid";
      const unpaid = body.action === "mark_unpaid";
      const { data: application, error: applicationError } = await service.from("event_applications")
        .select("id,final_amount_won").eq("id", applicationId).eq("event_id", currentEventId).maybeSingle();
      if (applicationError) throw applicationError;
      if (!application) err("신청 내역을 찾지 못했습니다.", 404);
      if (application.final_amount_won == null) err("신청자별 기본 참가비를 먼저 입력해 주세요.", 409);
      if (paid && Number(application.final_amount_won) > 0 && payment.fee_won == null) err("일정 참가비 설정을 먼저 완료해 주세요.", 409);
      let actualPaid: number | null = null;
      if (paid) {
        actualPaid = body.actual_paid_won == null || body.actual_paid_won === "" ? Number(application.final_amount_won) : Number(body.actual_paid_won);
        if (!Number.isSafeInteger(actualPaid) || actualPaid < 0 || actualPaid > 1000000) err("실제 입금액은 0원부터 100만원까지 입력해 주세요.", 400);
      }
      const patch = paid
        ? { payment_status: "PAID", actual_paid_won: actualPaid, financial_locked_at: new Date().toISOString(), paid_at: new Date().toISOString(), paid_recorded_by: userId, updated_at: new Date().toISOString() }
        : unpaid
          ? { payment_status: "UNPAID", actual_paid_won: null, paid_at: null, paid_recorded_by: null, updated_at: new Date().toISOString() }
          : { payment_status: "REFUNDED", refunded_at: new Date().toISOString(), refunded_recorded_by: userId, updated_at: new Date().toISOString() };
      let change = service.from("event_applications").update(patch).eq("id", applicationId).eq("event_id", currentEventId);
      change = paid ? change.eq("status", "APPLIED").eq("payment_status", "UNPAID")
        : unpaid ? change.eq("status", "APPLIED").eq("payment_status", "PAID")
          : change.eq("status", "CANCELLED").eq("payment_status", "REFUND_PENDING");
      const { data: changed, error: changeError } = await change.select("id,status,payment_status").maybeSingle();
      if (changeError) throw changeError;
      if (!changed) err("상태가 변경돼 처리하지 못했습니다. 목록을 새로 확인해 주세요.", 409);
      if (paid) {
        const { error: couponError } = await service.from("event_coupon_redemptions").update({ status: "USED", used_at: new Date().toISOString() })
          .eq("application_id", applicationId).eq("status", "RESERVED");
        if (couponError) throw couponError;
      }
      if (paid) await notifyWithoutBlocking(service, "MEMBER_PAYMENT_CONFIRMED", event, payment, applicationId);
      return reply(origin, { ok: true, application: changed });
    }

    if (body.action === "confirm" || body.action === "unconfirm") {
      const applicationId = numberId(body.application_id);
      const desired = body.action === "confirm" ? "CONFIRMED" : "APPLIED";
      const { data: application, error: applicationError } = await service.from("event_applications")
        .select("id,final_amount_won").eq("id", applicationId).eq("event_id", currentEventId).maybeSingle();
      if (applicationError) throw applicationError;
      if (!application) err("신청 내역을 찾지 못했습니다.", 404);
      if (desired === "CONFIRMED" && application.final_amount_won == null) err("신청자별 기본 참가비를 먼저 입력해 주세요.", 409);
      if (desired === "CONFIRMED" && payment.fee_won == null && Number(application.final_amount_won) > 0) err("일정 참가비를 먼저 설정해 주세요.", 409);
      let update = service.from("event_applications").update({
        status: desired,
        confirmed_at: desired === "CONFIRMED" ? new Date().toISOString() : null,
        ...(desired === "CONFIRMED" ? { financial_locked_at: new Date().toISOString() } : {}),
        ...(desired === "CONFIRMED" && Number(application.final_amount_won) === 0 ? { actual_paid_won: 0 } : {}),
        updated_at: new Date().toISOString(),
      }).eq("id", applicationId).eq("event_id", currentEventId);
      update = desired === "CONFIRMED"
        ? update.eq("status", "APPLIED").eq("payment_status", Number(application.final_amount_won) > 0 ? "PAID" : "UNPAID")
        : update.eq("status", "CONFIRMED");
      const { data, error } = await update.select("id,status,payment_status").maybeSingle();
      if (error) throw error;
      if (!data) err("신청 상태 또는 입금 확인 여부를 점검해 주세요.", 409);
      if (desired === "CONFIRMED") {
        const { error: couponError } = await service.from("event_coupon_redemptions").update({ status: "USED", used_at: new Date().toISOString() })
          .eq("application_id", applicationId).eq("status", "RESERVED");
        if (couponError) throw couponError;
      }
      if (desired === "CONFIRMED") await notifyWithoutBlocking(service, "MEMBER_PARTICIPATION_CONFIRMED", event, payment, applicationId);
      return reply(origin, { ok: true, application: data });
    }

    const { data: applications, error: listError } = await service.from("event_applications")
      .select("id,member_id,status,applied_at,confirmed_at,cancelled_at,payment_status,paid_at,refunded_at,base_fee_won,applied_coupon_ids,applied_coupons_snapshot,discount_amount_won,final_amount_won,actual_paid_won,priority_participant,financial_locked_at,refund_rule_code,refund_rate_percent,refund_amount_won,refund_deduction_won")
      .eq("event_id", currentEventId).order("priority_participant", { ascending: false }).order("applied_at", { ascending: true });
    if (listError) throw listError;
    const rows = applications || [];
    const count = rows.filter((item: any) => item.status !== "CANCELLED").length;
    const mine = member ? rows.find((item: any) => Number(item.member_id) === Number(member.id)) : null;
    let availableCoupons: any[] = [];
    if (member && (!mine || mine.status === "CANCELLED")) {
      const now = new Date().toISOString();
      const { data: couponRows, error: couponError } = await service.from("event_coupons")
        .select("id,title,coupon_type,value,valid_from,expires_at,one_time,stackable")
        .eq("is_active", true).lte("valid_from", now).or(`expires_at.is.null,expires_at.gt.${now}`)
        .or(`allowed_event_id.is.null,allowed_event_id.eq.${currentEventId}`)
        .or(`allowed_member_id.is.null,allowed_member_id.eq.${member.id}`).order("created_at", { ascending: false });
      if (couponError) throw couponError;
      const oneTimeIds = (couponRows || []).filter((item: any) => item.one_time).map((item: any) => item.id);
      const { data: redemptions, error: redemptionError } = oneTimeIds.length
        ? await service.from("event_coupon_redemptions").select("coupon_id,status").eq("member_id", member.id).in("coupon_id", oneTimeIds).in("status", ["RESERVED", "USED"])
        : { data: [], error: null };
      if (redemptionError) throw redemptionError;
      const unavailable = new Set((redemptions || []).map((item: any) => String(item.coupon_id)));
      availableCoupons = (couponRows || []).filter((item: any) => !item.one_time || !unavailable.has(String(item.id)));
    }
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
      mine: mine ? {
        id: mine.id, status: mine.status, payment_status: mine.payment_status,
        applied_at: mine.applied_at, confirmed_at: mine.confirmed_at, cancelled_at: mine.cancelled_at,
        base_fee_won: mine.base_fee_won, applied_coupons_snapshot: mine.applied_coupons_snapshot,
        discount_amount_won: mine.discount_amount_won, final_amount_won: mine.final_amount_won,
        actual_paid_won: mine.actual_paid_won, priority_participant: mine.priority_participant,
        financial_locked_at: mine.financial_locked_at, refund_rule_code: mine.refund_rule_code,
        refund_rate_percent: mine.refund_rate_percent, refund_amount_won: mine.refund_amount_won,
        refund_deduction_won: mine.refund_deduction_won,
      } : null,
      available_coupons: availableCoupons,
      notification: member ? {
        enabled: Boolean(payment.messaging_enabled),
        has_phone: Boolean(normalizeKoreanMobile(member.phone)),
        event_transaction_enabled: preference?.event_transaction_enabled === true,
      } : null,
      is_member: member?.is_active === true,
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
      const applicationIds = rows.map((item: any) => Number(item.id));
      const { data: historyRows, error: historyError } = applicationIds.length
        ? await service.from("event_application_financial_history").select("id,application_id,reason,before_values,after_values,created_at")
          .in("application_id", applicationIds).order("created_at", { ascending: false })
        : { data: [], error: null };
      if (historyError) throw historyError;
      const { data: refundHistoryRows, error: refundHistoryError } = applicationIds.length
        ? await service.from("event_application_refund_history")
          .select("id,application_id,status,requested_at,event_date_snapshot,confirmed_at_snapshot,headcount_fixed_at_snapshot,refund_rule_code,refund_rule_label,refund_rate_percent,actual_paid_snapshot_won,refund_amount_won,deduction_amount_won,completed_at,completed_by,policy_snapshot")
          .in("application_id", applicationIds).order("created_at", { ascending: false })
        : { data: [], error: null };
      if (refundHistoryError) throw refundHistoryError;
      const refundHistoryByApplication = new Map<number, any[]>();
      for (const item of refundHistoryRows || []) {
        const id = Number(item.application_id);
        const list = refundHistoryByApplication.get(id) || [];
        list.push(item);
        refundHistoryByApplication.set(id, list);
      }
      const { data: policyHistory, error: policyHistoryError } = await service.from("event_refund_policy_history")
        .select("id,before_values,after_values,created_at").eq("event_id", currentEventId).order("created_at", { ascending: false }).limit(20);
      if (policyHistoryError) throw policyHistoryError;
      result.refund_policy_history = policyHistory || [];
      const historyByApplication = new Map<number, any[]>();
      for (const item of historyRows || []) {
        const id = Number(item.application_id);
        const list = historyByApplication.get(id) || [];
        list.push(item);
        historyByApplication.set(id, list);
      }
      result.applications = rows.map((item: any) => ({
        id: item.id,
        name: names.get(String(item.member_id)) || "회원",
        status: item.status,
        payment_status: item.payment_status,
        applied_at: item.applied_at,
        confirmed_at: item.confirmed_at,
        cancelled_at: item.cancelled_at,
        paid_at: item.paid_at,
        refunded_at: item.refunded_at,
        base_fee_won: item.base_fee_won,
        applied_coupon_ids: item.applied_coupon_ids,
        applied_coupons_snapshot: item.applied_coupons_snapshot,
        discount_amount_won: item.discount_amount_won,
        final_amount_won: item.final_amount_won,
        actual_paid_won: item.actual_paid_won,
        priority_participant: item.priority_participant,
        financial_locked_at: item.financial_locked_at,
        financial_history: historyByApplication.get(Number(item.id)) || [],
        refund_rule_code: item.refund_rule_code,
        refund_rate_percent: item.refund_rate_percent,
        refund_amount_won: item.refund_amount_won,
        refund_deduction_won: item.refund_deduction_won,
        refund_history: refundHistoryByApplication.get(Number(item.id)) || [],
      }));
      const { data: coupons, error: couponError } = await service.from("event_coupons")
        .select("id,title,coupon_type,value,allowed_event_id,allowed_member_id,valid_from,expires_at,one_time,stackable,is_active,created_at")
        .eq("allowed_event_id", currentEventId).order("created_at", { ascending: false });
      if (couponError) throw couponError;
      result.event_coupons = coupons || [];
      const { data: eligibleMembers, error: memberError } = await service.from("members")
        .select("id,name").eq("is_active", true).order("name", { ascending: true });
      if (memberError) throw memberError;
      result.eligible_members = eligibleMembers || [];
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


