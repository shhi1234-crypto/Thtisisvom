const SOLAPI_SEND_URL = "https://api.solapi.com/messages/v4/send-many/detail";

export const EVENT_MESSAGE_KINDS = [
  "MEMBER_APPLICATION_RECEIVED",
  "MEMBER_PAYMENT_CONFIRMED",
  "MEMBER_PARTICIPATION_CONFIRMED",
  "MEMBER_APPLICATION_CANCELLED",
  "OPERATOR_APPLICATION_RECEIVED",
  "OPERATOR_APPLICATION_CANCELLED",
] as const;

export type EventMessageKind = typeof EVENT_MESSAGE_KINDS[number];

type EventRow = {
  id: number;
  title?: string | null;
  event_date?: string | null;
  start_time?: string | null;
  location?: string | null;
};

type PaymentRow = {
  fee_won?: number | null;
  payment_instructions?: string | null;
  refund_instructions?: string | null;
  payment_due_at?: string | null;
  messaging_enabled?: boolean | null;
  message_sms_fallback_enabled?: boolean | null;
  confirmed_chat_url?: string | null;
};

type ApplicationRow = {
  id: number;
  member_id: number;
  applied_at?: string | null;
  paid_at?: string | null;
  confirmed_at?: string | null;
  cancelled_at?: string | null;
};

type MemberRow = { id: number; name?: string | null; phone?: string | null };

type OutboxRow = {
  id: number;
  event_id: number;
  application_id: number;
  recipient_member_id: number;
  message_kind: EventMessageKind;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
};

const encoder = new TextEncoder();

function text(value: unknown, max = 500) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max);
}

function messageError(value: unknown) {
  return text(value, 480) || "message_delivery_failed";
}

export function normalizeKoreanMobile(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return /^01\d{8,9}$/.test(digits) ? digits : null;
}

export function safeHttpsUrl(value: unknown) {
  const raw = text(value, 2048);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error("참가 확정 안내 링크를 다시 확인해 주세요.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("참가 확정 안내 링크는 안전한 https 주소만 사용할 수 있어요.");
  }
  return url.toString();
}

function eventLabel(event: EventRow) {
  const day = text(event.event_date, 20);
  const time = text(event.start_time, 12).slice(0, 5);
  const place = text(event.location, 80);
  return [day, time, place].filter(Boolean).join(" · ") || "일정 정보는 MY VOM에서 확인해 주세요.";
}

function moneyLabel(fee: unknown) {
  const amount = Number(fee);
  return Number.isSafeInteger(amount) && amount >= 0 ? (amount === 0 ? "무료" : `${amount.toLocaleString("ko-KR")}원`) : "운영진 안내 확인";
}

function dueLabel(value: unknown) {
  const date = value ? new Date(String(value)) : null;
  if (!date || Number.isNaN(date.getTime())) return "별도 안내";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function applicationUrl(eventId: number) {
  return `https://thisisvom.vercel.app/apply/?id=${Number(eventId)}`;
}

function preferenceColumn(kind: EventMessageKind) {
  return kind.startsWith("OPERATOR_") ? "operator_alert_enabled" : "event_transaction_enabled";
}

function eventDedupedAt(kind: EventMessageKind, application: ApplicationRow) {
  if (kind === "MEMBER_APPLICATION_RECEIVED" || kind === "OPERATOR_APPLICATION_RECEIVED") return application.applied_at;
  if (kind === "MEMBER_PAYMENT_CONFIRMED") return application.paid_at;
  if (kind === "MEMBER_PARTICIPATION_CONFIRMED") return application.confirmed_at;
  return application.cancelled_at;
}

function payloadFor(event: EventRow, payment: PaymentRow, applicant: MemberRow, fallbackSms: boolean) {
  return {
    recipient_name: text(applicant.name, 40) || "회원",
    applicant_name: text(applicant.name, 40) || "회원",
    event_title: text(event.title, 100) || "VOM 일정",
    event_label: eventLabel(event),
    fee_label: moneyLabel(payment.fee_won),
    payment_due_label: dueLabel(payment.payment_due_at),
    payment_instructions: text(payment.payment_instructions, 500) || "MY VOM에서 입금 안내를 확인해 주세요.",
    refund_instructions: text(payment.refund_instructions, 500) || "운영진이 확인 후 안내해 드립니다.",
    confirmed_chat_url: safeHttpsUrl(payment.confirmed_chat_url) || "MY VOM에서 안내 예정",
    application_url: applicationUrl(event.id),
    fallback_sms_enabled: Boolean(fallbackSms),
  };
}

export async function updateOwnMessagingContact(
  service: any,
  memberId: number,
  authUserId: string,
  phone: unknown,
  consent: unknown,
) {
  if (consent !== true) throw new Error("알림을 받으려면 수신 동의가 필요해요.");
  const mobile = normalizeKoreanMobile(phone);
  if (!mobile) throw new Error("휴대폰 번호를 숫자로 정확히 입력해 주세요.");
  const now = new Date().toISOString();
  const { error: phoneError } = await service.from("members")
    .update({ phone: mobile })
    .eq("id", memberId)
    .eq("auth_user_id", authUserId)
    .eq("is_active", true);
  if (phoneError) throw phoneError;
  const { error: preferenceError } = await service.from("member_message_preferences").upsert({
    member_id: memberId,
    event_transaction_enabled: true,
    event_transaction_consented_at: now,
    updated_at: now,
  }, { onConflict: "member_id" });
  if (preferenceError) throw preferenceError;
}

export async function ensureOwnEventMessagingContact(
  service: any,
  member: MemberRow,
  authUserId: string,
  phone: unknown,
  consent: unknown,
) {
  const { data: preference, error } = await service.from("member_message_preferences")
    .select("event_transaction_enabled")
    .eq("member_id", member.id)
    .maybeSingle();
  if (error) throw error;
  if (normalizeKoreanMobile(member.phone) && preference?.event_transaction_enabled === true) return;
  await updateOwnMessagingContact(service, member.id, authUserId, phone, consent);
}

async function enqueue(
  service: any,
  kind: EventMessageKind,
  event: EventRow,
  payment: PaymentRow,
  application: ApplicationRow,
  recipient: MemberRow,
  applicant: MemberRow,
) {
  const occurredAt = eventDedupedAt(kind, application) || new Date().toISOString();
  const dedupeKey = `${kind}:${application.id}:${occurredAt}`.slice(0, 180);
  const payload = payloadFor(event, payment, applicant, Boolean(payment.message_sms_fallback_enabled));
  payload.recipient_name = text(recipient.name, 40) || payload.recipient_name;
  const { error } = await service.from("event_message_outbox").upsert({
    event_id: event.id,
    application_id: application.id,
    recipient_member_id: recipient.id,
    message_kind: kind,
    dedupe_key: dedupeKey,
    payload,
    status: "QUEUED",
    next_attempt_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "recipient_member_id,dedupe_key", ignoreDuplicates: true });
  if (error) throw error;
}

export async function queueApplicationMessages(
  service: any,
  kind: EventMessageKind,
  event: EventRow,
  payment: PaymentRow,
  application: ApplicationRow,
  applicant: MemberRow,
) {
  if (!payment.messaging_enabled) return { queued: 0 };
  let queued = 0;
  if (!kind.startsWith("OPERATOR_")) {
    await enqueue(service, kind, event, payment, application, applicant, applicant);
    queued++;
  }
  const operatorKind: EventMessageKind | null = kind === "MEMBER_APPLICATION_RECEIVED"
    ? "OPERATOR_APPLICATION_RECEIVED"
    : kind === "MEMBER_APPLICATION_CANCELLED"
      ? "OPERATOR_APPLICATION_CANCELLED"
      : null;
  if (!operatorKind) return { queued };
  const { data: operators, error } = await service.from("members")
    .select("id,name,role")
    .eq("is_active", true)
    .in("role", ["모임장", "운영진"]);
  if (error) throw error;
  const operatorIds = (operators || []).map((operator: any) => Number(operator.id)).filter(Number.isSafeInteger);
  if (!operatorIds.length) return { queued };
  const { data: preferences, error: preferenceError } = await service.from("member_message_preferences")
    .select("member_id,operator_alert_enabled")
    .in("member_id", operatorIds)
    .eq("operator_alert_enabled", true);
  if (preferenceError) throw preferenceError;
  const optedIn = new Set((preferences || []).map((item: any) => Number(item.member_id)));
  for (const operator of operators || []) {
    if (!optedIn.has(Number(operator.id))) continue;
    await enqueue(service, operatorKind, event, payment, application, operator, applicant);
    queued++;
  }
  return { queued };
}

function configuredSecrets() {
  const apiKey = Deno.env.get("SOLAPI_API_KEY") || "";
  const apiSecret = Deno.env.get("SOLAPI_API_SECRET") || "";
  const senderPhone = normalizeKoreanMobile(Deno.env.get("SOLAPI_SENDER_PHONE"));
  const pfId = Deno.env.get("SOLAPI_KAKAO_PF_ID") || "";
  return apiKey && apiSecret && senderPhone && pfId ? { apiKey, apiSecret, senderPhone, pfId } : null;
}

function templateIdFor(kind: EventMessageKind) {
  const names: Record<EventMessageKind, string> = {
    MEMBER_APPLICATION_RECEIVED: "SOLAPI_TEMPLATE_APPLICATION_RECEIVED",
    MEMBER_PAYMENT_CONFIRMED: "SOLAPI_TEMPLATE_PAYMENT_CONFIRMED",
    MEMBER_PARTICIPATION_CONFIRMED: "SOLAPI_TEMPLATE_PARTICIPATION_CONFIRMED",
    MEMBER_APPLICATION_CANCELLED: "SOLAPI_TEMPLATE_APPLICATION_CANCELLED",
    OPERATOR_APPLICATION_RECEIVED: "SOLAPI_TEMPLATE_OPERATOR_APPLICATION",
    OPERATOR_APPLICATION_CANCELLED: "SOLAPI_TEMPLATE_OPERATOR_CANCELLED",
  };
  return Deno.env.get(names[kind]) || "";
}

async function authorization(apiKey: string, apiSecret: string) {
  const date = new Date().toISOString();
  const salt = crypto.randomUUID().replace(/-/g, "");
  const signingKey = await crypto.subtle.importKey(
    "raw", encoder.encode(apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(date + salt)));
  const signature = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

function variablesFor(kind: EventMessageKind, payload: Record<string, unknown>) {
  const value = (key: string) => text(payload[key], 500);
  const common = { "#{회원명}": value("recipient_name"), "#{일정명}": value("event_title"), "#{일정일시}": value("event_label") };
  if (kind === "MEMBER_APPLICATION_RECEIVED") return {
    ...common, "#{참가비}": value("fee_label"), "#{입금기한}": value("payment_due_label"),
    "#{입금안내}": value("payment_instructions"), "#{신청상태링크}": value("application_url"),
  };
  if (kind === "MEMBER_PAYMENT_CONFIRMED") return { ...common, "#{신청상태링크}": value("application_url") };
  if (kind === "MEMBER_PARTICIPATION_CONFIRMED") return { ...common, "#{오픈채팅링크}": value("confirmed_chat_url") };
  if (kind === "MEMBER_APPLICATION_CANCELLED") return { ...common, "#{환불안내}": value("refund_instructions"), "#{신청상태링크}": value("application_url") };
  return { "#{신청자명}": value("applicant_name"), "#{일정명}": value("event_title"), "#{일정일시}": value("event_label"), "#{신청상태링크}": value("application_url") };
}

function fallbackText(kind: EventMessageKind, payload: Record<string, unknown>) {
  const value = (key: string) => text(payload[key], 700);
  const common = `${value("event_title")}\n${value("event_label")}`;
  if (kind === "MEMBER_APPLICATION_RECEIVED") return `[VOM 신청 완료]\n${value("recipient_name")}님, 신청이 완료됐어요.\n${common}\n참가비: ${value("fee_label")}\n입금 기한: ${value("payment_due_label")}\n${value("payment_instructions")}\n상태 확인: ${value("application_url")}`;
  if (kind === "MEMBER_PAYMENT_CONFIRMED") return `[VOM 입금 확인]\n${value("recipient_name")}님, 입금 확인이 완료됐어요.\n${common}\n참가 확정은 MY VOM에서 안내해 드릴게요.\n${value("application_url")}`;
  if (kind === "MEMBER_PARTICIPATION_CONFIRMED") return `[VOM 참가 확정]\n${value("recipient_name")}님, 참가가 확정됐어요.\n${common}\n오픈채팅 입장: ${value("confirmed_chat_url")}`;
  if (kind === "MEMBER_APPLICATION_CANCELLED") return `[VOM 신청 취소]\n${value("recipient_name")}님, 신청 취소가 접수됐어요.\n${value("event_title")}\n${value("refund_instructions")}\n${value("application_url")}`;
  const verb = kind === "OPERATOR_APPLICATION_RECEIVED" ? "신청했습니다" : "취소했습니다";
  return `[VOM 운영 알림]\n${value("applicant_name")}님이 ${value("event_title")}에 ${verb}.\n${value("event_label")}\n${value("application_url")}`;
}

async function mark(service: any, id: number, patch: Record<string, unknown>) {
  const { error } = await service.from("event_message_outbox").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export async function dispatchEventMessages(service: any, limit = 12) {
  const now = new Date().toISOString();
  const { data: pending, error } = await service.from("event_message_outbox")
    .select("id,event_id,application_id,recipient_member_id,message_kind,payload,status,attempts")
    .eq("status", "QUEUED")
    .lte("next_attempt_at", now)
    .order("id", { ascending: true })
    .limit(Math.max(1, Math.min(50, Number(limit) || 12)));
  if (error) throw error;
  let accepted = 0, failed = 0, skipped = 0, waiting = 0;
  for (const pendingRow of pending || []) {
    const job = pendingRow as OutboxRow;
    const { data: claimed, error: claimError } = await service.from("event_message_outbox")
      .update({ status: "SENDING", locked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", job.id).eq("status", "QUEUED")
      .select("id,event_id,application_id,recipient_member_id,message_kind,payload,status,attempts")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue;
    const current = claimed as OutboxRow;
    const [recipientResult, preferenceResult] = await Promise.all([
      service.from("members").select("id,name,phone,is_active").eq("id", current.recipient_member_id).maybeSingle(),
      service.from("member_message_preferences").select("event_transaction_enabled,operator_alert_enabled").eq("member_id", current.recipient_member_id).maybeSingle(),
    ]);
    if (recipientResult.error || preferenceResult.error) {
      await mark(service, current.id, { status: "FAILED", last_error: "recipient_lookup_failed", locked_at: null });
      failed++;
      continue;
    }
    const recipient = recipientResult.data as MemberRow & { is_active?: boolean } | null;
    const preference = preferenceResult.data as Record<string, unknown> | null;
    if (!recipient?.is_active || !normalizeKoreanMobile(recipient.phone) || preference?.[preferenceColumn(current.message_kind)] !== true) {
      await mark(service, current.id, { status: "SKIPPED", last_error: "recipient_not_opted_in_or_invalid_phone", locked_at: null });
      skipped++;
      continue;
    }
    const secrets = configuredSecrets();
    const templateId = templateIdFor(current.message_kind);
    if (!secrets || !templateId) {
      await mark(service, current.id, { status: "WAITING_FOR_CONFIGURATION", last_error: "solapi_configuration_incomplete", locked_at: null });
      waiting++;
      continue;
    }
    try {
      const auth = await authorization(secrets.apiKey, secrets.apiSecret);
      const response = await fetch(SOLAPI_SEND_URL, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{
            to: normalizeKoreanMobile(recipient.phone),
            from: secrets.senderPhone,
            text: fallbackText(current.message_kind, current.payload),
            kakaoOptions: {
              pfId: secrets.pfId,
              templateId,
              variables: variablesFor(current.message_kind, current.payload),
              disableSms: current.payload.fallback_sms_enabled !== true,
            },
            customFields: { vom_outbox_id: String(current.id), vom_event_id: String(current.event_id) },
          }],
          allowDuplicates: false,
          showMessageList: true,
        }),
      });
      const responseText = await response.text();
      let responseBody: any = null;
      try { responseBody = JSON.parse(responseText); } catch (_) { /* handled below */ }
      const message = responseBody?.messageList?.[0] || responseBody?.failedMessageList?.[0];
      if (!response.ok || String(message?.statusCode || "").startsWith("4") || String(message?.statusCode || "").startsWith("5")) {
        await mark(service, current.id, { status: "FAILED", attempts: Number(current.attempts || 0) + 1, last_error: messageError(responseBody?.errorMessage || message?.statusCode || `solapi_http_${response.status}`), locked_at: null });
        failed++;
        continue;
      }
      await mark(service, current.id, {
        status: "ACCEPTED",
        attempts: Number(current.attempts || 0) + 1,
        provider_message_id: text(message?.messageId || responseBody?.groupInfo?.groupId, 160) || null,
        accepted_at: new Date().toISOString(),
        last_error: null,
        locked_at: null,
      });
      accepted++;
    } catch (_) {
      // An unknown network outcome can already have been accepted upstream. Do not retry automatically.
      await mark(service, current.id, { status: "FAILED", attempts: Number(current.attempts || 0) + 1, last_error: "solapi_request_unknown_outcome", locked_at: null });
      failed++;
    }
  }
  return { checked: (pending || []).length, accepted, failed, skipped, waiting };
}

