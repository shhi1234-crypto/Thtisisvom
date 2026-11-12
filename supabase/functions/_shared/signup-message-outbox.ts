import { normalizeKoreanMobile } from "./event-message-outbox.ts";
import { nextMemberKakaoAllowedAt } from "./kakao-quiet-hours.ts";

const SOLAPI_SEND_URL = "https://api.solapi.com/messages/v4/send-many/detail";

export const SIGNUP_MESSAGE_KINDS = [
  "SIGNUP_APPLICATION_RECEIVED",
  "SIGNUP_APPROVED",
  "SIGNUP_REJECTED",
] as const;

export type SignupMessageKind = typeof SIGNUP_MESSAGE_KINDS[number];

type SignupMessageInput = {
  inviteId: string;
  reviewId?: number | null;
  kind: SignupMessageKind;
  phone: unknown;
  name: unknown;
};

type SignupOutboxRow = {
  id: number;
  invite_id: string;
  review_id?: number | null;
  message_kind: SignupMessageKind;
  recipient_phone: string | null;
  consent_snapshot: boolean;
  recipient_name: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
};

function text(value: unknown, max = 500) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max);
}

function messageError(value: unknown) {
  return text(value, 480) || "message_delivery_failed";
}

function configuredSecrets() {
  const apiKey = Deno.env.get("SOLAPI_API_KEY") || "";
  const apiSecret = Deno.env.get("SOLAPI_API_SECRET") || "";
  const senderPhone = normalizeKoreanMobile(Deno.env.get("SOLAPI_SENDER_PHONE"));
  const pfId = Deno.env.get("SOLAPI_KAKAO_PF_ID") || "";
  return apiKey && apiSecret && senderPhone && pfId ? { apiKey, apiSecret, senderPhone, pfId } : null;
}

function templateIdFor(kind: SignupMessageKind) {
  const names: Record<SignupMessageKind, string> = {
    SIGNUP_APPLICATION_RECEIVED: "SOLAPI_TEMPLATE_SIGNUP_APPLICATION_RECEIVED",
    SIGNUP_APPROVED: "SOLAPI_TEMPLATE_SIGNUP_APPROVED",
    SIGNUP_REJECTED: "SOLAPI_TEMPLATE_SIGNUP_REJECTED",
  };
  return Deno.env.get(names[kind]) || "";
}

async function authorization(apiKey: string, apiSecret: string) {
  const date = new Date().toISOString();
  const salt = crypto.randomUUID().replace(/-/g, "");
  const encoder = new TextEncoder();
  const signingKey = await crypto.subtle.importKey(
    "raw", encoder.encode(apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(date + salt)));
  const signature = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

function payloadFor(kind: SignupMessageKind, name: unknown) {
  const recipientName = text(name, 60) || "회원";
  return {
    recipient_name: recipientName,
    applicant_name: recipientName,
    confirmation_url: kind === "SIGNUP_APPROVED"
      ? "https://thisisvom.vercel.app/me/"
      : kind === "SIGNUP_REJECTED"
        ? "https://thisisvom.vercel.app/"
        : "https://thisisvom.vercel.app/ot-room/?result=1",
    fallback_sms_enabled: false,
  };
}

function variablesFor(payload: Record<string, unknown>) {
  return {
    "#{신청자명}": text(payload.applicant_name, 60),
    "#{확인링크}": text(payload.confirmation_url, 2048),
  };
}

function fallbackText(kind: SignupMessageKind, payload: Record<string, unknown>) {
  const name = text(payload.applicant_name, 60) || "회원";
  const url = text(payload.confirmation_url, 2048);
  if (kind === "SIGNUP_APPLICATION_RECEIVED") {
    return `[VOM 가입 신청 접수]\n${name}님, 가입 신청이 접수되었습니다.\n운영진 검토 후 결과를 안내해 드립니다.\n확인: ${url}`;
  }
  if (kind === "SIGNUP_APPROVED") {
    return `[VOM 가입 승인]\n${name}님, VOM 가입 신청이 승인되었습니다.\n홈페이지에서 로그인해 주세요.\n${url}`;
  }
  return `[VOM 가입 결과 안내]\n${name}님, 이번 가입 신청은 승인되지 않았습니다.\n추가 안내가 필요하면 홈페이지에서 문의해 주세요.\n${url}`;
}

export async function queueSignupMessage(service: any, input: SignupMessageInput) {
  const phone = normalizeKoreanMobile(input.phone);
  const name = text(input.name, 60);
  if (!phone || !name) return { queued: 0, skipped: true };
  const dedupeKey = `${input.kind}:${input.reviewId ?? "application"}`.slice(0, 180);
  const payload = payloadFor(input.kind, name);
  const { error } = await service.from("signup_message_outbox").upsert({
    invite_id: input.inviteId,
    review_id: input.reviewId ?? null,
    message_kind: input.kind,
    recipient_phone: phone,
    recipient_name: name,
    consent_snapshot: true,
    dedupe_key: dedupeKey,
    payload,
    status: "QUEUED",
    next_attempt_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "invite_id,dedupe_key", ignoreDuplicates: true });
  if (error) throw error;
  return { queued: 1, skipped: false };
}

export async function queueSignupApplicationReceived(
  service: any,
  inviteId: string,
  phone: unknown,
  name: unknown,
  consent: boolean,
) {
  if (!consent) return { queued: 0, skipped: true };
  const mobile = normalizeKoreanMobile(phone);
  if (!mobile) return { queued: 0, skipped: true };
  const { error } = await service.from("signup_message_preferences").upsert({
    invite_id: inviteId,
    phone: mobile,
    enabled: true,
    consented_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "invite_id" });
  if (error) throw error;
  return queueSignupMessage(service, {
    inviteId,
    kind: "SIGNUP_APPLICATION_RECEIVED",
    phone,
    name,
  });
}

export async function queueSignupResultMessage(service: any, reviewId: number, status: string) {
  const kind: SignupMessageKind = status === "APPROVED"
    ? "SIGNUP_APPROVED"
    : status === "REJECTED"
      ? "SIGNUP_REJECTED"
      : null as never;
  if (!kind) return { queued: 0, skipped: true };
  const { data: review, error: reviewError } = await service.from("ot_reviews")
    .select("id,candidate_name,status")
    .eq("id", reviewId)
    .maybeSingle();
  if (reviewError) throw reviewError;
  if (!review || review.status !== status) return { queued: 0, skipped: true };
  const { data: invite, error: inviteError } = await service.from("ot_room_invites")
    .select("id")
    .eq("review_id", reviewId)
    .maybeSingle();
  if (inviteError) throw inviteError;
  if (!invite) return { queued: 0, skipped: true };
  const [{ data: applicant, error: applicantError }, { data: preference, error: preferenceError }] = await Promise.all([
    service.from("ot_room_applicants").select("phone,candidate_name").eq("invite_id", invite.id).maybeSingle(),
    service.from("signup_message_preferences").select("phone,enabled").eq("invite_id", invite.id).maybeSingle(),
  ]);
  if (applicantError || preferenceError) throw applicantError || preferenceError;
  if (!preference?.enabled) return { queued: 0, skipped: true };
  return queueSignupMessage(service, {
    inviteId: invite.id,
    reviewId,
    kind,
    phone: preference.phone || applicant?.phone,
    name: applicant?.candidate_name || review.candidate_name,
  });
}

async function mark(service: any, id: number, patch: Record<string, unknown>) {
  const { error } = await service.from("signup_message_outbox")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function dispatchSignupMessages(service: any, limit = 12) {
  const dispatchAt = new Date();
  const now = dispatchAt.toISOString();
  const quietUntil = nextMemberKakaoAllowedAt(dispatchAt);
  if (quietUntil) {
    const { data: deferred, error: deferError } = await service.from("signup_message_outbox")
      .update({ next_attempt_at: quietUntil, updated_at: now })
      .in("status", ["QUEUED", "WAITING_FOR_CONFIGURATION"])
      .lte("next_attempt_at", now)
      .select("id");
    if (deferError) throw deferError;
    return { checked: 0, accepted: 0, failed: 0, skipped: 0, waiting: 0, deferred: (deferred || []).length };
  }
  const { data: pending, error } = await service.from("signup_message_outbox")
    .select("id,invite_id,review_id,message_kind,recipient_phone,recipient_name,consent_snapshot,payload,status,attempts")
    .in("status", ["QUEUED", "WAITING_FOR_CONFIGURATION"])
    .lte("next_attempt_at", now)
    .order("id", { ascending: true })
    .limit(Math.max(1, Math.min(50, Number(limit) || 12)));
  if (error) throw error;
  let accepted = 0, failed = 0, skipped = 0, waiting = 0;
  for (const row of pending || []) {
    const job = row as SignupOutboxRow;
    const { data: claimed, error: claimError } = await service.from("signup_message_outbox")
      .update({ status: "SENDING", locked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", job.id)
      .in("status", ["QUEUED", "WAITING_FOR_CONFIGURATION"])
      .select("id,invite_id,review_id,message_kind,recipient_phone,recipient_name,consent_snapshot,payload,status,attempts")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue;
    const current = claimed as SignupOutboxRow;
    const { data: preference, error: preferenceError } = await service.from("signup_message_preferences")
      .select("phone,enabled")
      .eq("invite_id", current.invite_id)
      .maybeSingle();
    if (preferenceError) {
      await mark(service, current.id, {
        status: "FAILED",
        recipient_phone: null,
        recipient_name: "회원",
        payload: {},
        last_error: "preference_lookup_failed",
        locked_at: null,
      });
      failed++;
      continue;
    }
    const recipientPhone = normalizeKoreanMobile(preference?.phone || current.recipient_phone);
    if ((preference && preference.enabled !== true) || current.consent_snapshot !== true || !recipientPhone) {
      await mark(service, current.id, { status: "SKIPPED", recipient_phone: null, recipient_name: "회원", payload: {}, last_error: "recipient_not_opted_in_or_invalid_phone", locked_at: null });
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
      const response = await fetch(SOLAPI_SEND_URL, {
        method: "POST",
        headers: { Authorization: await authorization(secrets.apiKey, secrets.apiSecret), "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{
            to: recipientPhone,
            from: secrets.senderPhone,
            text: fallbackText(current.message_kind, current.payload),
            kakaoOptions: {
              pfId: secrets.pfId,
              templateId,
              variables: variablesFor(current.payload),
              disableSms: true,
            },
            customFields: { vom_signup_outbox_id: String(current.id), vom_invite_id: current.invite_id },
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
        await mark(service, current.id, {
          status: "FAILED",
          recipient_phone: null,
          recipient_name: "회원",
          payload: {},
          attempts: Number(current.attempts || 0) + 1,
          last_error: messageError(responseBody?.errorMessage || message?.statusCode || `solapi_http_${response.status}`),
          locked_at: null,
        });
        failed++;
        continue;
      }
      await mark(service, current.id, {
        status: "ACCEPTED",
        recipient_phone: null,
        recipient_name: "회원",
        payload: {},
        attempts: Number(current.attempts || 0) + 1,
        provider_message_id: text(message?.messageId || responseBody?.groupInfo?.groupId, 160) || null,
        accepted_at: new Date().toISOString(),
        last_error: null,
        locked_at: null,
      });
      accepted++;
    } catch (_) {
      await mark(service, current.id, {
        status: "FAILED",
        recipient_phone: null,
        recipient_name: "회원",
        payload: {},
        attempts: Number(current.attempts || 0) + 1,
        last_error: "solapi_request_unknown_outcome",
        locked_at: null,
      });
      failed++;
    }
  }
  return { checked: (pending || []).length, accepted, failed, skipped, waiting };
}

