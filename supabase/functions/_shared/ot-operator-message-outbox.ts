import { normalizeKoreanMobile } from "./event-message-outbox.ts";
import { retryDelayMs, retryableProviderFailure } from "./notification-schedule.ts";

const SOLAPI_SEND_URL = "https://api.solapi.com/messages/v4/send-many/detail";
const SIX_HOURS = 6 * 60 * 60_000;
const SIGNUP_OPERATOR_REMINDERS_START_AT = Date.parse("2026-11-20T00:29:52.000Z");
const MAX_ATTEMPTS = 5;

export type OperatorReminderKind = "SIGNUP_OPERATOR_REVIEW_6H" | "SIGNUP_OPERATOR_APPLICATION_RECEIVED";

function clean(value: unknown, max = 500) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max);
}

function configuredSecrets() {
  const apiKey = Deno.env.get("SOLAPI_API_KEY") || "";
  const apiSecret = Deno.env.get("SOLAPI_API_SECRET") || "";
  const senderPhone = normalizeKoreanMobile(Deno.env.get("SOLAPI_SENDER_PHONE"));
  const pfId = Deno.env.get("SOLAPI_KAKAO_PF_ID") || "";
  return apiKey && apiSecret && senderPhone && pfId ? { apiKey, apiSecret, senderPhone, pfId } : null;
}

function templateIdFor(kind: OperatorReminderKind) {
  return kind === "SIGNUP_OPERATOR_APPLICATION_RECEIVED"
    ? Deno.env.get("SOLAPI_TEMPLATE_SIGNUP_OPERATOR_APPLICATION_RECEIVED") || ""
    : Deno.env.get("SOLAPI_TEMPLATE_SIGNUP_OPERATOR_REVIEW_6H") || "";
}

export function operatorReminderVariables(_kind: OperatorReminderKind, operatorName: unknown, applicantName: unknown, reviewId: number) {
  return {
    "#{운영진명}": clean(operatorName, 60),
    "#{신청자명}": clean(applicantName, 60),
    // The SOLAPI button is configured as https://#{검토링크}.
    "#{검토링크}": `thisisvom.vercel.app/ot-admin/?id=${Number(reviewId)}`,
  };
}

function fallbackText(kind: OperatorReminderKind, operatorName: unknown, applicantName: unknown, reviewId: number) {
  const operator = clean(operatorName, 60) || "운영진";
  const applicant = clean(applicantName, 60) || "신청자";
  const link = `https://thisisvom.vercel.app/ot-admin/?id=${Number(reviewId)}`;
  if (kind === "SIGNUP_OPERATOR_APPLICATION_RECEIVED") {
    return `[VOM 가입 신청 알림]\n${operator}님, ${applicant}님의 회원가입 신청이 접수됐습니다.\n아래 버튼에서 신청 내용을 확인하고 검토를 진행해 주세요.\n${link}`;
  }
  return `[VOM 가입 심사 알림]\n${operator}님, ${applicant}님의 가입 신청 접수 후 6시간이 지났지만 심사가 아직 미확정입니다.\n아직 의견을 남기지 않은 운영진에게만 안내드려요. 검토해 주세요.\n${link}`;
}

function backoff(attempt: number, now = new Date()) {
  return new Date(now.getTime() + retryDelayMs(attempt)).toISOString();
}

async function mark(service: any, id: number, patch: Record<string, unknown>) {
  const { error } = await service.from("ot_operator_message_outbox")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function queueSignupOperatorReminders(service: any, now = new Date()) {
  const { data: reviews, error: reviewError } = await service.from("ot_reviews")
    .select("id,candidate_name,created_at,eligible_operator_ids")
    .eq("status", "IN_REVIEW")
    .order("created_at", { ascending: true })
    .limit(1000);
  if (reviewError) throw reviewError;
  if (!reviews?.length) return { queued: 0, eligible: 0 };

  const reviewIds = reviews.map((review: any) => Number(review.id));
  const allOperatorIds = [...new Set(reviews.flatMap((review: any) => (review.eligible_operator_ids || []).map(Number)))]
    .filter((id: number) => Number.isSafeInteger(id) && id > 0);
  const [{ data: votes, error: voteError }, { data: operators, error: operatorError }, { data: preferences, error: preferenceError }] = await Promise.all([
    service.from("ot_review_votes").select("review_id,voter_member_id").in("review_id", reviewIds),
    allOperatorIds.length
      ? service.from("members").select("id,name,role,is_active,phone").in("id", allOperatorIds).in("role", ["운영진", "모임장"]).eq("is_active", true)
      : Promise.resolve({ data: [], error: null }),
    allOperatorIds.length
      ? service.from("member_message_preferences").select("member_id,operator_alert_enabled").in("member_id", allOperatorIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (voteError || operatorError || preferenceError) throw voteError || operatorError || preferenceError;

  const voted = new Set((votes || []).map((vote: any) => `${Number(vote.review_id)}:${Number(vote.voter_member_id)}`));
  const operatorById = new Map((operators || []).map((operator: any) => [Number(operator.id), operator]));
  const preferenceById = new Map((preferences || []).map((preference: any) => [Number(preference.member_id), preference]));
  let queued = 0, eligible = 0;
  const currentTime = now.getTime();
  for (const review of reviews || []) {
    const created = Date.parse(String(review.created_at || ""));
    if (!Number.isFinite(created) || created < SIGNUP_OPERATOR_REMINDERS_START_AT || currentTime < created + SIX_HOURS) continue;

    for (const operatorId of (review.eligible_operator_ids || []).map(Number)) {
      const operator = operatorById.get(operatorId) as any;
      if (!operator || voted.has(`${Number(review.id)}:${operatorId}`) || (preferenceById.get(operatorId) as any)?.operator_alert_enabled !== true || !normalizeKoreanMobile(operator.phone)) continue;
      eligible++;
      const { error } = await service.from("ot_operator_message_outbox").upsert({
        review_id: Number(review.id),
        recipient_member_id: operatorId,
        message_kind: "SIGNUP_OPERATOR_REVIEW_6H",
        status: "QUEUED",
        next_attempt_at: now.toISOString(),
        updated_at: now.toISOString(),
      }, { onConflict: "review_id,recipient_member_id,message_kind", ignoreDuplicates: true });
      if (error) throw error;
      queued++;
    }
  }
  return { queued, eligible };
}

async function recoverExpiredLeases(service: any, now: Date) {
  const expiredBefore = new Date(now.getTime() - 10 * 60_000).toISOString();
  const { error } = await service.from("ot_operator_message_outbox")
    .update({ status: "FAILED", locked_at: null, last_error: "delivery_outcome_unknown", updated_at: now.toISOString() })
    .eq("status", "SENDING")
    .lt("locked_at", expiredBefore);
  if (error) throw error;
}

export async function dispatchSignupOperatorReminders(service: any, limit = 20, now = new Date()) {
  await recoverExpiredLeases(service, now);
  const nowIso = now.toISOString();
  const { data: pending, error } = await service.from("ot_operator_message_outbox")
    .select("id,review_id,recipient_member_id,message_kind,status,attempts")
    .in("status", ["QUEUED", "WAITING_FOR_CONFIGURATION"])
    .lte("next_attempt_at", nowIso)
    .order("id", { ascending: true })
    .limit(Math.max(1, Math.min(50, Number(limit) || 20)));
  if (error) throw error;

  let accepted = 0, failed = 0, skipped = 0, waiting = 0;
  for (const row of pending || []) {
    const { data: claimed, error: claimError } = await service.from("ot_operator_message_outbox")
      .update({ status: "SENDING", locked_at: nowIso, updated_at: nowIso })
      .eq("id", row.id)
      .in("status", ["QUEUED", "WAITING_FOR_CONFIGURATION"])
      .select("id,review_id,recipient_member_id,message_kind,status,attempts")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue;

    const kind = String(claimed.message_kind) as OperatorReminderKind;
    const [{ data: review, error: reviewError }, { data: operator, error: operatorError }, { data: vote, error: voteError }, { data: preference, error: preferenceError }] = await Promise.all([
      service.from("ot_reviews").select("id,candidate_name,status").eq("id", claimed.review_id).maybeSingle(),
      service.from("members").select("id,name,phone,role,is_active").eq("id", claimed.recipient_member_id).maybeSingle(),
      service.from("ot_review_votes").select("review_id").eq("review_id", claimed.review_id).eq("voter_member_id", claimed.recipient_member_id).maybeSingle(),
      service.from("member_message_preferences").select("operator_alert_enabled").eq("member_id", claimed.recipient_member_id).maybeSingle(),
    ]);
    if (reviewError || operatorError || voteError || preferenceError) {
      const attempts = Number(claimed.attempts || 0) + 1;
      await mark(service, Number(claimed.id), { status: attempts >= MAX_ATTEMPTS ? "FAILED" : "QUEUED", attempts, next_attempt_at: backoff(attempts, now), last_error: "recipient_lookup_failed", locked_at: null });
      failed++;
      continue;
    }
    if (review?.status !== "IN_REVIEW" || vote || !operator?.is_active || !["운영진", "모임장"].includes(String(operator.role || ""))) {
      await mark(service, Number(claimed.id), { status: "SKIPPED", last_error: "review_resolved_or_operator_checked", locked_at: null });
      skipped++;
      continue;
    }
    if (preference?.operator_alert_enabled !== true) {
      await mark(service, Number(claimed.id), { status: "SKIPPED", last_error: "operator_alert_consent_disabled", locked_at: null });
      skipped++;
      continue;
    }
    const phone = normalizeKoreanMobile(operator.phone);
    if (!phone) {
      await mark(service, Number(claimed.id), { status: "SKIPPED", last_error: "operator_phone_missing_or_invalid", locked_at: null });
      skipped++;
      continue;
    }
    const secrets = configuredSecrets();
    const templateId = templateIdFor(kind);
    if (!secrets || !templateId) {
      await mark(service, Number(claimed.id), { status: "WAITING_FOR_CONFIGURATION", next_attempt_at: new Date(now.getTime() + 30 * 60_000).toISOString(), last_error: "solapi_configuration_incomplete", locked_at: null });
      waiting++;
      continue;
    }

    try {
      const date = new Date().toISOString();
      const salt = crypto.randomUUID().replace(/-/g, "");
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", encoder.encode(secrets.apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(date + salt)));
      const signature = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const response = await fetch(SOLAPI_SEND_URL, {
        method: "POST",
        headers: { Authorization: `HMAC-SHA256 apiKey=${secrets.apiKey}, date=${date}, salt=${salt}, signature=${signature}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{
            to: phone,
            from: secrets.senderPhone,
            text: fallbackText(kind, operator.name, review.candidate_name, Number(review.id)),
            kakaoOptions: {
              pfId: secrets.pfId,
              templateId,
              variables: operatorReminderVariables(kind, operator.name, review.candidate_name, Number(review.id)),
              disableSms: true,
            },
            customFields: { vom_ot_operator_outbox_id: String(claimed.id), vom_review_id: String(review.id), vom_operator_member_id: String(operator.id) },
          }],
          allowDuplicates: false,
          showMessageList: true,
        }),
      });
      const responseText = await response.text();
      let responseBody: any = null;
      try { responseBody = JSON.parse(responseText); } catch { /* handled by status below */ }
      const message = responseBody?.messageList?.[0] || responseBody?.failedMessageList?.[0];
      const providerStatus = message?.statusCode;
      if (!response.ok || String(providerStatus || "").startsWith("4") || String(providerStatus || "").startsWith("5")) {
        const attempts = Number(claimed.attempts || 0) + 1;
        const retryable = retryableProviderFailure(response.status, providerStatus);
        await mark(service, Number(claimed.id), {
          status: retryable && attempts < MAX_ATTEMPTS ? "QUEUED" : "FAILED",
          attempts,
          next_attempt_at: backoff(attempts, now),
          last_error: clean(responseBody?.errorMessage || providerStatus || `solapi_http_${response.status}`, 480) || "message_delivery_failed",
          locked_at: null,
        });
        if (retryable && attempts < MAX_ATTEMPTS) waiting++; else failed++;
        continue;
      }
      await mark(service, Number(claimed.id), {
        status: "ACCEPTED",
        attempts: Number(claimed.attempts || 0) + 1,
        provider_message_id: clean(message?.messageId || responseBody?.groupInfo?.groupId, 160) || null,
        accepted_at: new Date().toISOString(),
        last_error: null,
        locked_at: null,
      });
      accepted++;
    } catch {
      // A timeout can happen after the provider accepted the send; never retry an unknown outcome automatically.
      await mark(service, Number(claimed.id), { status: "FAILED", attempts: Number(claimed.attempts || 0) + 1, last_error: "solapi_request_unknown_outcome", locked_at: null });
      failed++;
    }
  }
  return { checked: (pending || []).length, accepted, failed, skipped, waiting };
}

