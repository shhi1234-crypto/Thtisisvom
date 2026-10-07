import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { ApiError, VIDEO_BUCKET, DEFAULT_ORIGIN, MAX_VIDEO_BYTES, MAX_PHOTO_BYTES, signupDetails, validatePhoto, checkRequest, failure, headers, isRegistrationOpen, json, requireOpen, textField, tokenHash, validToken, validateVideo } from "../_shared/ot-core.ts";
import { notifyOT } from "../_shared/ot-push.ts";
import { applicantEmail, loginName, newPassword, signedIn } from "../_shared/member-access.ts";
import { publicSignup } from "../_shared/public-signup.ts";

// An invite creates one applicant account. Subsequent submissions/status reads
// require that account's verified JWT; approval alone creates a member profile.
export async function handle(req: Request, service: any, now = () => new Date()) {
  let origin = DEFAULT_ORIGIN;
  let claim: { inviteId: string; claimId: string; path: string | null; committed: boolean; photo: boolean } | null = null;
  let accountClaim: {inviteId:string;claimId:string;userId:string|null} | null = null;
  try {
    origin = checkRequest(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
    if (new URL(req.url).searchParams.get('signup')==='public') return await publicSignup(req,service,origin,now);
    const rawToken = req.headers.get("x-ot-invite");
    const ownUser = req.headers.get("authorization") ? await signedIn(req,service) : null;
    let lookup=service.from("ot_room_invites").select("id,expires_at,revoked_at,review_id,somoim_nickname,applicant_user_id");
    if (validToken(rawToken)) lookup=lookup.eq("token_hash",await tokenHash(rawToken));
    else if (ownUser) lookup=lookup.eq("applicant_user_id",ownUser.id);
    else throw new ApiError(404,"운영진이 안내한 등록 링크를 확인하거나 개인 계정으로 로그인해 주세요.","invalid_invite");
    const { data: invite, error } = await lookup.maybeSingle();
    if (error) throw new Error("invite_lookup_failed");
    if (!invite || invite.revoked_at || (!invite.applicant_user_id && new Date(invite.expires_at) <= now())) throw new ApiError(404, "등록 링크가 만료됐거나 유효하지 않습니다. 운영진에게 다시 안내받아 주세요.", "invalid_invite");
    const ownsAccount=!!ownUser && ownUser.id===invite.applicant_user_id;

    const isMultipart = (req.headers.get("content-type") || "").startsWith("multipart/form-data;");
    if (!isMultipart) {
      let body;
      try { body = await req.json(); } catch { throw new ApiError(400, "요청 내용을 확인해 주세요."); }
      if (body.action === "create_account") {
        if (!validToken(rawToken) || invite.applicant_user_id || invite.review_id) throw new ApiError(409,"이미 가입 계정이 설정된 링크입니다. 개인 계정으로 로그인해 주세요.");
        if (ownUser) throw new ApiError(409,"현재 계정에서 로그아웃한 뒤 신규 가입을 신청해 주세요.");
        if (body.consent!==true) throw new ApiError(400,"가입 검토 목적의 개인정보 수집·이용에 동의해 주세요.");
        const name=loginName(body.login_name),password=newPassword(body.password);
        const profile:any={...signupDetails(body,now()),login_name:name,candidate_name:textField(body.candidate_name,60,"이름"),somoim_nickname:textField(body.somoim_nickname,80,"소모임 닉네임")};
        for (const [key,max] of [["phone",30],["region",80],["gender",20]] as const) profile[key]=body[key] ? textField(body[key],max,key) : null;
        const claimId=crypto.randomUUID(),stamp=now().toISOString(),before=new Date(now().getTime()-600000).toISOString();
        const {data:reserved,error:re}=await service.from("ot_room_invites").update({account_claim_id:claimId,account_claimed_at:stamp})
          .eq("id",invite.id).is("applicant_user_id",null).is("review_id",null).is("revoked_at",null).gt("expires_at",stamp)
          .or(`account_claimed_at.is.null,account_claimed_at.lt.${before}`).select("id").maybeSingle();
        if (re) throw new Error("account_reservation_failed");
        if (!reserved) throw new ApiError(409,"가입 계정 설정이 진행 중입니다. 잠시 후 확인해 주세요.");
        accountClaim={inviteId:invite.id,claimId,userId:null};
        const email=await applicantEmail(name);
        const {data:created,error:ce}=await service.auth.admin.createUser({email,password,email_confirm:true});
        if (ce || !created.user) throw new ApiError(409,"사용할 수 없는 아이디입니다. 다른 아이디를 입력해 주세요.");
        accountClaim.userId=created.user.id;
        const {error:be}=await service.rpc("vom_ot_bind_account",{p_invite_id:invite.id,p_claim_id:claimId,p_user_id:created.user.id,p_profile:profile});
        if (be) throw new Error("account_bind_failed");
        accountClaim=null;
        return json(origin,{ok:true,login_email:email},201);
      }
      if (body.action !== "info") throw new ApiError(400,"지원하지 않는 요청입니다.");
      if (invite.applicant_user_id && !ownsAccount) return json(origin,{ok:true,account_exists:true,login_required:true,server_time:now().toISOString()});
      const {data:profile,error:pe}=ownsAccount ? await service.from("ot_room_applicants").select("login_name,candidate_name,somoim_nickname,phone,birth_date,birth_year,job,busking_experience,busking_experience_unit,form_version,profile_photo_path,region,gender,member_id").eq("auth_user_id",ownUser.id).single() : {data:null,error:null};
      if (pe) throw new Error("applicant_lookup_failed");
      let status = null;
      if (invite.review_id) {
        const { data: review, error: re } = await service.from("ot_reviews").select("status,completed_at").eq("id", invite.review_id).single();
        if (re) throw new Error("review_lookup_failed");
        status = review.completed_at ? "JOINED" : review.status;
      }
      const safeProfile=profile ? {...profile,has_photo:!!profile.profile_photo_path} : null;
      if (safeProfile) delete safeProfile.profile_photo_path;
      return json(origin, { ok: true, account_exists:!!invite.applicant_user_id,profile:safeProfile,registration_open: isRegistrationOpen(now()), server_time: now().toISOString(), somoim_nickname: invite.somoim_nickname || "", submitted: !!invite.review_id, status });
    }

    const photo=new URL(req.url).searchParams.get("upload")==="photo";
    const limit=photo ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
    const sizeMessage=photo ? "본인사진은 5MB 이하로 등록해 주세요." : "영상·음성 파일은 50MB 이하로 등록해 주세요.";
    if (!photo) requireOpen(now());
    if (!ownsAccount) throw new ApiError(401,"가입 계정을 설정한 뒤 본인 계정으로 파일을 등록해 주세요.","login_required");
    const {data:profile,error:pe}=await service.from("ot_room_applicants").select("candidate_name,somoim_nickname,form_version,profile_photo_path").eq("auth_user_id",ownUser.id).single();
    if (pe || !profile) throw new Error("applicant_lookup_failed");
    if (invite.review_id) throw new ApiError(409, "이미 회원가입 신청이 접수됐습니다. 운영진 안내를 기다려 주세요.", "already_submitted");
    if (photo && profile.profile_photo_path) throw new ApiError(409,"본인사진이 이미 등록됐습니다.");
    if (!photo && profile.form_version>=2 && !profile.profile_photo_path) throw new ApiError(400,"본인사진을 먼저 등록해 주세요.","photo_required");
    const length = Number(req.headers.get("content-length") || 0);
    if (length > limit + 64 * 1024) throw new ApiError(413, sizeMessage);
    const claimId = crypto.randomUUID();
    const stamp = now().toISOString();
    const before = new Date(now().getTime() - 10 * 60_000).toISOString();
    const { data: reserved, error: reserveError } = await service.from("ot_room_invites")
      .update({ upload_claim_id: claimId, upload_claimed_at: stamp })
      .eq("id", invite.id).is("review_id", null).is("revoked_at", null).gt("expires_at", stamp)
      .or(`upload_claimed_at.is.null,upload_claimed_at.lt.${before}`).select("id").maybeSingle();
    if (reserveError) throw new Error("upload_reservation_failed");
    if (!reserved) throw new ApiError(409, "영상 등록이 진행 중이거나 완료됐습니다. 잠시 후 등록 상태를 확인해 주세요.", "upload_in_progress");
    claim = { inviteId: invite.id, claimId, path: null, committed: false, photo };

    let form;
    let received = 0, sizeLimitReached = false;
    if (!req.body) throw new ApiError(400, "영상 파일을 읽지 못했습니다.");
    const limitedBody = req.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > limit + 64 * 1024) {
          sizeLimitReached = true;
          throw new Error("multipart_size_limit");
        }
        controller.enqueue(chunk);
      },
    }));
    try { form = await new Response(limitedBody, { headers: { "Content-Type": req.headers.get("content-type") || "" } }).formData(); }
    catch { throw new ApiError(sizeLimitReached ? 413 : 400, sizeLimitReached ? sizeMessage : "파일을 읽지 못했습니다."); }
    if (!photo) requireOpen(now());
    const candidateName = profile.candidate_name;
    const nickname = profile.somoim_nickname;
    if (!photo && form.get("consent") !== "yes") throw new ApiError(400, "가입 확인을 위한 영상·음성 검토에 동의해 주세요.");
    const file = form.get(photo ? "photo" : "video");
    if (!(file instanceof File)) throw new ApiError(400, "사진 또는 라이브 영상·음성 파일을 선택해 주세요.");
    const { mime, extension } = await (photo ? validatePhoto(file) : validateVideo(file));
    const filePath = `${photo ? "profiles" : "reviews"}/${invite.id}/${claimId}.${extension}`;
    claim.path = filePath;
    if (!photo) requireOpen(now());
    const { error: uploadError } = await service.storage.from(VIDEO_BUCKET).upload(filePath, file.slice(0,file.size,mime), { contentType: mime, cacheControl: "0", upsert: false });
    if (uploadError) throw new Error("video_upload_failed");
    if (photo) {
      const {error:fe}=await service.rpc("vom_ot_finalize_photo",{p_invite_id:invite.id,p_claim_id:claimId,p_file_path:filePath,p_file_name:file.name.replace(/[\x00-\x1f\x7f]/g,"").slice(0,180)});
      if (fe) throw new ApiError(409,"사진 등록 상태를 다시 확인해 주세요.","photo_finalize_failed");
      claim.committed=true;
      return json(origin,{ok:true,has_photo:true,message:"본인사진이 등록됐습니다."},201);
    }
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
    return json(origin, { ok: true, submitted: true, status: "IN_REVIEW", message: "회원가입 신청이 접수됐습니다. 당일 처리가 보장되지는 않으며, 운영진 확인 후 익일 안내될 수 있습니다." }, 201);
  } catch (error) {
    return failure(origin, error);
  } finally {
    if (accountClaim) {
      try {
        const {data:current,error}=await service.from("ot_room_invites").select("applicant_user_id").eq("id",accountClaim.inviteId).maybeSingle();
        if (!error && current && !current.applicant_user_id) {
          if (accountClaim.userId) await service.auth.admin.deleteUser(accountClaim.userId);
          await service.from("ot_room_invites").update({account_claim_id:null,account_claimed_at:null}).eq("id",accountClaim.inviteId).eq("account_claim_id",accountClaim.claimId).is("applicant_user_id",null);
        }
      } catch {console.error("OT account reconciliation deferred");}
    }
    if (claim && !claim.committed) {
      try {
        // A network failure can hide a successful SQL commit. Reconcile before
        // deleting bytes so a submitted review never loses its video.
        const { data: current, error } = await service.from("ot_room_invites").select("review_id").eq("id", claim.inviteId).maybeSingle();
        const {data:photoProfile,error:photoError}=claim.photo ? await service.from("ot_room_applicants").select("profile_photo_path").eq("invite_id",claim.inviteId).maybeSingle() : {data:null,error:null};
        if (!error && !photoError && current && !current.review_id && (!claim.photo || (photoProfile && (!claim.path || photoProfile.profile_photo_path!==claim.path)))) {
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
