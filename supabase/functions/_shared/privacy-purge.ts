import { VIDEO_BUCKET } from "./ot-core.ts";
import { queueSignupResultMessage } from "./signup-message-outbox.ts";

async function eraseAuthIdentity(service: any, userId: string | null | undefined) {
  if (!userId) return;
  const { error } = await service.auth.admin.updateUserById(userId, {
    email: `withdrawn-${userId}@example.com`,
    email_confirm: true,
    password: crypto.randomUUID() + crypto.randomUUID(),
    user_metadata: {},
    ban_duration: "876000h",
  });
  if (error) throw new Error("privacy_auth_erase_failed");
}

async function removeMedia(service: any, paths: Array<string | null | undefined>) {
  const clean = [...new Set(paths.filter((path): path is string => typeof path === "string" && path.length > 0))];
  if (!clean.length) return;
  const { error } = await service.storage.from(VIDEO_BUCKET).remove(clean);
  if (error) throw new Error("privacy_media_delete_failed");
}

async function clearPendingSignupMessages(service: any, inviteId: string, status: string) {
  const { error: terminalError } = await service.from("signup_message_outbox")
    .update({ recipient_phone: null, recipient_name: "회원", payload: {}, updated_at: new Date().toISOString() })
    .eq("invite_id", inviteId)
    .in("status", ["ACCEPTED", "SKIPPED", "FAILED"]);
  if (terminalError) throw new Error("privacy_terminal_outbox_cleanup_failed");

  const kinds = status === "REJECTED"
    ? ["SIGNUP_APPLICATION_RECEIVED"]
    : ["SIGNUP_APPLICATION_RECEIVED", "SIGNUP_APPROVED", "SIGNUP_REJECTED"];
  const { error } = await service.from("signup_message_outbox")
    .update({
      status: "SKIPPED",
      recipient_phone: null,
      recipient_name: "회원",
      payload: {},
      last_error: "application_data_purged",
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("invite_id", inviteId)
    .in("message_kind", kinds)
    .in("status", ["QUEUED", "WAITING_FOR_CONFIGURATION", "FAILED"]);
  if (error) throw new Error("privacy_outbox_cleanup_failed");
}

async function clearSignupInvite(service: any, inviteId: string, userId?: string | null) {
  const now = new Date().toISOString();
  const { error: applicantError } = await service.from("ot_room_applicants")
    .delete().eq("invite_id", inviteId);
  if (applicantError) throw new Error("privacy_applicant_delete_failed");

  const { error: pushError } = await service.from("ot_applicant_push_subscriptions")
    .delete().eq("invite_id", inviteId);
  if (pushError) throw new Error("privacy_push_delete_failed");

  const { error: reservationError } = await service.from("ot_signup_reservations")
    .delete().eq("invite_id", inviteId);
  if (reservationError) throw new Error("privacy_reservation_delete_failed");

  const { error: preferenceError } = await service.from("signup_message_preferences")
    .delete().eq("invite_id", inviteId);
  if (preferenceError) throw new Error("privacy_preference_delete_failed");

  const patch: Record<string, unknown> = {
    applicant_user_id: null,
    somoim_nickname: null,
    revoked_at: now,
    notification_token_hash: null,
    notification_expires_at: null,
    notification_push_enabled: false,
    upload_claim_id: null,
    upload_claimed_at: null,
    account_claim_id: null,
    account_claimed_at: null,
  };
  const { error: inviteError } = await service.from("ot_room_invites")
    .update(patch).eq("id", inviteId);
  if (inviteError) throw new Error("privacy_invite_cleanup_failed");

  await eraseAuthIdentity(service, userId);
}

export async function purgeResolvedSignup(service: any, reviewId: number) {
  const { data: review, error: reviewError } = await service.from("ot_reviews")
    .select("id,status,completed_at,candidate_name,somoim_nickname,video_file_path,video_url,created_by,privacy_purged_at")
    .eq("id", reviewId).maybeSingle();
  if (reviewError) throw new Error("privacy_review_lookup_failed");
  if (!review || !["REJECTED", "DISCARDED"].includes(review.status) || review.completed_at) {
    return { purged: false, reason: "not_terminal" };
  }
  if (review.privacy_purged_at) return { purged: true, already_purged: true };

  const { data: invite, error: inviteError } = await service.from("ot_room_invites")
    .select("id,applicant_user_id").eq("review_id", reviewId).maybeSingle();
  if (inviteError) throw new Error("privacy_invite_lookup_failed");
  const { data: applicant, error: applicantError } = invite
    ? await service.from("ot_room_applicants")
      .select("auth_user_id,profile_photo_path,member_id")
      .eq("invite_id", invite.id).maybeSingle()
    : { data: null, error: null };
  if (applicantError) throw new Error("privacy_profile_lookup_failed");
  if (applicant?.member_id) return { purged: false, reason: "linked_member" };

  const userId = applicant?.auth_user_id || invite?.applicant_user_id;
  await removeMedia(service, [review.video_file_path, applicant?.profile_photo_path]);
  await eraseAuthIdentity(service, userId);

  if (invite) {
    await clearPendingSignupMessages(service, invite.id, review.status);
    await clearSignupInvite(service, invite.id, userId);
  }

  const now = new Date().toISOString();
  const { error: reviewUpdateError } = await service.from("ot_reviews").update({
    candidate_name: "삭제된 신청자",
    somoim_nickname: "삭제된 신청자",
    video_url: null,
    video_file_path: null,
    video_file_name: null,
    memo: null,
    discard_reason: null,
    created_by: null,
    privacy_purged_at: now,
    updated_at: now,
  }).eq("id", reviewId);
  if (reviewUpdateError) throw new Error("privacy_review_redaction_failed");

  const { error: logError } = await service.from("ot_review_discard_log")
    .update({ reason: null }).eq("review_id", reviewId);
  if (logError) throw new Error("privacy_discard_log_cleanup_failed");
  return { purged: true };
}

/** Requeues a result notice before purging and retries partially completed purges on cron. */
export async function purgeResolvedSignups(service: any, limit = 25) {
  const { data: reviews, error } = await service.from("ot_reviews")
    .select("id,status")
    .in("status", ["REJECTED", "DISCARDED"])
    .is("completed_at", null)
    .is("privacy_purged_at", null)
    .order("resolved_at", { ascending: true })
    .limit(Math.max(1, Math.min(100, Number(limit) || 25)));
  if (error) throw new Error("privacy_purge_queue_lookup_failed");
  let purged = 0, deferred = 0;
  for (const review of reviews || []) {
    if (review.status === "REJECTED") {
      await queueSignupResultMessage(service, Number(review.id), "REJECTED");
    }
    const result = await purgeResolvedSignup(service, Number(review.id));
    if (result.purged) purged++;
    else deferred++;
  }
  return { checked: (reviews || []).length, purged, deferred };
}

export async function anonymizeMemberAccount(service: any, memberId: number) {
  const { data: member, error: lookupError } = await service.from("members")
    .select("id,name,auth_user_id").eq("id", memberId).maybeSingle();
  if (lookupError || !member) throw new Error("member_privacy_lookup_failed");

  if (member.auth_user_id) {
    const { data: adminIdentity, error: adminCheckError } = await service.from("admins")
      .select("user_id").eq("user_id", member.auth_user_id).maybeSingle();
    if (adminCheckError) throw new Error("member_privacy_admin_check_failed");
    if (adminIdentity) {
      const { error: revokeAdminError } = await service.from("admins").delete().eq("user_id", member.auth_user_id);
      if (revokeAdminError) throw new Error("member_privacy_admin_revocation_failed");
    }
  }

  // Deactivate first so a partial cleanup cannot leave an account usable.
  const { error: deactivateError } = await service.from("members")
    .update({ is_active: false }).eq("id", memberId);
  if (deactivateError) throw new Error("member_privacy_deactivation_failed");

  const { data: applicantRows, error: applicantsError } = await service.from("ot_room_applicants")
    .select("invite_id,auth_user_id,profile_photo_path")
    .eq("member_id", memberId);
  if (applicantsError) throw new Error("member_privacy_applicant_lookup_failed");

  for (const applicant of applicantRows || []) {
    const { data: invite, error: inviteLookupError } = await service.from("ot_room_invites")
      .select("id,review_id").eq("id", applicant.invite_id).maybeSingle();
    if (inviteLookupError) throw new Error("member_privacy_invite_lookup_failed");
    let review: any = null;
    if (invite?.review_id) {
      const { data, error } = await service.from("ot_reviews")
        .select("id,video_file_path").eq("id", invite.review_id).maybeSingle();
      if (error) throw new Error("member_privacy_review_lookup_failed");
      review = data;
    }
    await removeMedia(service, [applicant.profile_photo_path, review?.video_file_path]);
    if (review) {
      const { error } = await service.from("ot_reviews").update({
        candidate_name: "삭제된 신청자",
        somoim_nickname: "삭제된 신청자",
        video_url: null,
        video_file_path: null,
        video_file_name: null,
        memo: null,
        discard_reason: null,
        created_by: null,
        updated_at: new Date().toISOString(),
      }).eq("id", review.id);
      if (error) throw new Error("member_privacy_review_redaction_failed");
      await service.from("ot_review_discard_log").update({ reason: null }).eq("review_id", review.id);
    }
    await clearPendingSignupMessages(service, applicant.invite_id, "DISCARDED");
    await clearSignupInvite(service, applicant.invite_id, applicant.auth_user_id);
  }

  const { data: questions, error: questionsError } = await service.from("vom_qna_questions")
    .select("id").eq("member_id", memberId);
  if (questionsError) throw new Error("member_privacy_questions_lookup_failed");
  const questionIds = (questions || []).map((row: any) => Number(row.id)).filter(Number.isSafeInteger);
  if (questionIds.length) {
    const { error: answerError } = await service.from("vom_qna_answers").delete().in("question_id", questionIds);
    if (answerError) throw new Error("member_privacy_answers_delete_failed");
    const { error: questionDeleteError } = await service.from("vom_qna_questions").delete().in("id", questionIds);
    if (questionDeleteError) throw new Error("member_privacy_questions_delete_failed");
  }

  const cleanupResults = await Promise.all([
    service.from("member_message_preferences").delete().eq("member_id", memberId),
    service.from("member_account_settings").delete().eq("member_id", memberId),
    service.from("member_activation_invites").delete().eq("member_id", memberId),
    service.from("member_coupons").delete().eq("member_id", memberId),
    service.from("ot_room_operator_access").delete().eq("member_id", memberId),
  ]);
  if (cleanupResults.some((result: any) => result.error)) throw new Error("member_privacy_related_data_cleanup_failed");

  const { error: eventOutboxError } = await service.from("event_message_outbox")
    .update({ status: "SKIPPED", payload: {}, last_error: "member_withdrew", locked_at: null, updated_at: new Date().toISOString() })
    .eq("recipient_member_id", memberId)
    .in("status", ["QUEUED", "WAITING_FOR_CONFIGURATION"]);
  if (eventOutboxError) throw new Error("member_privacy_event_outbox_cleanup_failed");
  const { error: eventPayloadError } = await service.from("event_message_outbox")
    .update({ payload: {}, updated_at: new Date().toISOString() }).eq("recipient_member_id", memberId);
  if (eventPayloadError) throw new Error("member_privacy_event_payload_cleanup_failed");

  const { error: staffLogError } = await service.from("ot_review_discard_log")
    .update({ actor_name: "탈퇴한 운영진" }).eq("actor_member_id", memberId);
  if (staffLogError) throw new Error("member_privacy_log_cleanup_failed");

  await eraseAuthIdentity(service, member.auth_user_id);
  const { error: memberUpdateError } = await service.from("members").update({
    name: `탈퇴회원-${memberId}`,
    nickname: null,
    profile_image_url: null,
    joined_at: null,
    note: null,
    role: null,
    birth_date: null,
    region: null,
    gender: null,
    favorite_singers: null,
    join_order: null,
    phone: null,
    instagram: null,
    memo: null,
    job: null,
    auth_user_id: null,
    last_attendance_manual_at: null,
    is_active: false,
  }).eq("id", memberId);
  if (memberUpdateError) throw new Error("member_privacy_redaction_failed");
  return { anonymized: true, retained_financial_records: true };
}
