import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { ApiError, VIDEO_BUCKET, DEFAULT_ORIGIN, MAX_VIDEO_BYTES, checkRequest, failure, headers, isRegistrationOpen, json, requireOpen, textField, tokenHash, validToken, validateVideo } from "../_shared/ot-core.ts";
import { notifyOT } from "../_shared/ot-push.ts";

// This endpoint deliberately accepts an OT invite instead of a member JWT.
// Invite holders receive no member credentials, member directory, or media read URL.
export async function handle(req: Request, service: any, now = () => new Date()) {
  let origin = DEFAULT_ORIGIN;
  let claim: { inviteId: string; claimId: string; path: string | null; committed: boolean } | null = null;
  try {
    origin = checkRequest(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
    const rawToken = req.headers.get("x-ot-invite");
    if (!validToken(rawToken)) throw new ApiError(404, "운영진이 안내한 등록 링크를 확인해 주세요.", "invalid_invite");
    const { data: invite, error } = await service.from("ot_room_invites")
      .select("id,expires_at,revoked_at,review_id,somoim_nickname")
      .eq("token_hash", await tokenHash(rawToken)).maybeSingle();
    if (error) throw new Error("invite_lookup_failed");
    if (!invite || invite.revoked_at || new Date(invite.expires_at) <= now()) throw new ApiError(404, "등록 링크가 만료됐거나 유효하지 않습니다. 운영진에게 다시 안내받아 주세요.", "invalid_invite");

    const isMultipart = (req.headers.get("content-type") || "").startsWith("multipart/form-data;");
    if (!isMultipart) {
      let body;
      try { body = await req.json(); } catch { throw new ApiError(400, "요청 내용을 확인해 주세요."); }
      if (body.action !== "info") throw new ApiError(400, "지원하지 않는 요청입니다.");
      let status = null;
      if (invite.review_id) {
        const { data: review, error: re } = await service.from("ot_reviews").select("status,completed_at").eq("id", invite.review_id).single();
        if (re) throw new Error("review_lookup_failed");
        status = review.completed_at ? "JOINED" : review.status;
      }
      return json(origin, { ok: true, registration_open: isRegistrationOpen(now()), server_time: now().toISOString(), somoim_nickname: invite.somoim_nickname || "", submitted: !!invite.review_id, status });
    }

    requireOpen(now());
    if (invite.review_id) throw new ApiError(409, "이미 영상이 등록됐습니다. 운영진 안내를 기다려 주세요.", "already_submitted");
    const length = Number(req.headers.get("content-length") || 0);
    if (length > MAX_VIDEO_BYTES + 64 * 1024) throw new ApiError(413, "영상은 50MB 이하로 등록해 주세요.");
    const claimId = crypto.randomUUID();
    const stamp = now().toISOString();
    const before = new Date(now().getTime() - 10 * 60_000).toISOString();
    const { data: reserved, error: reserveError } = await service.from("ot_room_invites")
      .update({ upload_claim_id: claimId, upload_claimed_at: stamp })
      .eq("id", invite.id).is("review_id", null).is("revoked_at", null).gt("expires_at", stamp)
      .or(`upload_claimed_at.is.null,upload_claimed_at.lt.${before}`).select("id").maybeSingle();
    if (reserveError) throw new Error("upload_reservation_failed");
    if (!reserved) throw new ApiError(409, "영상 등록이 진행 중이거나 완료됐습니다. 잠시 후 등록 상태를 확인해 주세요.", "upload_in_progress");
    claim = { inviteId: invite.id, claimId, path: null, committed: false };

    let form;
    let received = 0, sizeLimitReached = false;
    if (!req.body) throw new ApiError(400, "영상 파일을 읽지 못했습니다.");
    const limitedBody = req.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAX_VIDEO_BYTES + 64 * 1024) {
          sizeLimitReached = true;
          throw new Error("multipart_size_limit");
        }
        controller.enqueue(chunk);
      },
    }));
    try { form = await new Response(limitedBody, { headers: { "Content-Type": req.headers.get("content-type") || "" } }).formData(); }
    catch { throw new ApiError(sizeLimitReached ? 413 : 400, sizeLimitReached ? "영상은 50MB 이하로 등록해 주세요." : "영상 파일을 읽지 못했습니다."); }
    requireOpen(now());
    const candidateName = textField(form.get("candidate_name"), 60, "이름");
    const nickname = textField(form.get("somoim_nickname"), 80, "소모임 닉네임");
    if (form.get("consent") !== "yes") throw new ApiError(400, "가입 확인을 위한 영상 검토에 동의해 주세요.");
    const file = form.get("video");
    if (!(file instanceof File)) throw new ApiError(400, "인증 영상을 선택해 주세요.");
    const { mime, extension } = await validateVideo(file);
    const filePath = `reviews/${invite.id}/${claimId}.${extension}`;
    claim.path = filePath;
    requireOpen(now());
    const { error: uploadError } = await service.storage.from(VIDEO_BUCKET).upload(filePath, file, { contentType: mime, cacheControl: "0", upsert: false });
    if (uploadError) throw new Error("video_upload_failed");
    requireOpen(now());
    // The SQL transaction checks clock_timestamp(), invite state and this exact claim again.
    const { data: review, error: finalizeError } = await service.rpc("vom_ot_finalize_upload", {
      p_invite_id: invite.id, p_claim_id: claimId, p_candidate_name: candidateName,
      p_somoim_nickname: nickname, p_file_path: filePath,
      p_file_name: file.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180),
    });
    if (finalizeError) {
      if (finalizeError.message?.includes("room_closed")) throw new ApiError(403, "오후 6시가 지나 등록되지 않았습니다. 다음 등록 시간에 다시 제출해 주세요.", "room_closed");
      throw new ApiError(409, "등록 상태를 다시 확인해 주세요. 완료되지 않았다면 다시 제출할 수 있습니다.", "finalize_failed");
    }
    const reviewId = Number(Array.isArray(review) ? review[0]?.id : review?.id);
    if (!reviewId) throw new Error("invalid_review_result");
    claim.committed = true;
    try { await notifyOT(service, reviewId); } catch { console.error("OT notification queued"); }
    return json(origin, { ok: true, submitted: true, status: "IN_REVIEW", message: "영상이 등록됐습니다. 당일 처리가 보장되지는 않으며, 운영진 확인 후 익일 안내될 수 있습니다." }, 201);
  } catch (error) {
    return failure(origin, error);
  } finally {
    if (claim && !claim.committed) {
      try {
        // A network failure can hide a successful SQL commit. Reconcile before
        // deleting bytes so a submitted review never loses its video.
        const { data: current, error } = await service.from("ot_room_invites").select("review_id").eq("id", claim.inviteId).maybeSingle();
        if (!error && current && !current.review_id) {
          // Removal uses the Storage API, never DELETE from storage.objects.
          if (claim.path) await service.storage.from(VIDEO_BUCKET).remove([claim.path]);
          await service.from("ot_room_invites").update({ upload_claim_id: null, upload_claimed_at: null })
            .eq("id", claim.inviteId).eq("upload_claim_id", claim.claimId).is("review_id", null);
        }
      } catch { console.error("OT upload cleanup deferred"); }
    }
  }
}

if (import.meta.main) Deno.serve((req: Request) => handle(req, createClient(
  Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  { auth: { persistSession: false, autoRefreshToken: false } },
)));
