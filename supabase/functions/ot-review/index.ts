import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { ApiError, VIDEO_BUCKET, DEFAULT_ORIGIN, checkRequest, failure, headers, json, mediaLink, newToken, positiveInt, requireOperator, textField, tokenHash } from "../_shared/ot-core.ts";
import { notifyPendingOT, notifyApproval, notifyPendingApprovals } from "../_shared/ot-push.ts";

export async function handle(req: Request, service: any) {
  let origin = DEFAULT_ORIGIN;
  try {
    origin = checkRequest(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
    const actor = await requireOperator(req, service);
    let body;
    try { body = await req.json(); } catch { throw new ApiError(400, "요청 내용을 확인해 주세요."); }
    const action = body.action;

    if (action === "context") return json(origin, { ok: true, actor });

    if(action==='device_notification_status'){
      const endpoint=textField(body.endpoint,2048,'이 기기의 알림 구독');
      const {data,error}=await service.from('vom_push_subscriptions').select('vom_push_invites!inner(recipient_name,is_active)')
        .eq('endpoint',endpoint).eq('is_active',true).eq('vom_push_invites.is_active',true).maybeSingle();
      if(error)throw new Error('device_notification_lookup_failed');
      const recipient=data?.vom_push_invites?.recipient_name;
      const {data:operator,error:oe}=recipient?await service.from('members').select('id').eq('name',recipient).eq('role','운영진').eq('is_active',true).maybeSingle():{data:null,error:null};
      if(oe)throw new Error('device_notification_operator_failed');
      return json(origin,{ok:true,registered:!!operator&&(actor.isAdmin||Number(operator.id)===Number(actor.memberId))});
    }

    if (action === "list") {
      const [{ data: reviews, error: re }, { data: operators, error: oe }, { data: invites, error: ie }, { data: accessRows, error: ae }] = await Promise.all([
        service.from("ot_reviews").select("id,candidate_name,somoim_nickname,status,due_at,created_at,resolved_at,eligible_operator_ids,required_majority,operator_notified_at,approval_notified_at,completed_member_id,completed_at,video_source,media_kind").order("created_at", { ascending: false }).limit(500),
        service.from("members").select("id,name,nickname,auth_user_id").eq("role", "운영진").eq("is_active", true).order("join_order", { ascending: true }),
        service.from("ot_room_invites").select("id,somoim_nickname,created_at,expires_at,revoked_at,review_id,signup_source").eq('signup_source','INVITE').order("created_at", { ascending: false }).limit(100),
        service.from("ot_room_operator_access").select("member_id,user_id,revoked_at"),
      ]);
      if (re || oe || ie || ae) throw new Error("ot_list_failed");
      const ids = (reviews || []).map((r: any) => r.id);
      const { data: votes, error: ve } = ids.length
        ? await service.from("ot_review_votes").select("review_id,voter_member_id,decision,updated_at").in("review_id", ids)
        : { data: [], error: null };
      if (ve) throw new Error("ot_votes_failed");
      const { data: members, error: me } = actor.isAdmin
        ? await service.from("members").select("id,name,nickname").eq("is_active", true).order("name")
        : { data: [], error: null };
      if (me) throw new Error("member_list_failed");
      const {data:profiles,error:pe}=ids.length ? await service.from("ot_room_applicants")
        .select("candidate_name,phone,birth_date,birth_year,job,busking_experience,busking_experience_unit,profile_photo_path,region,gender,ot_room_invites!inner(review_id,notification_push_enabled)")
        .in("ot_room_invites.review_id",ids) : {data:[],error:null};
      if (pe) throw new Error("applicant_list_failed");
      const {data:pushDevices,error:pde}=actor.isAdmin?await service.from('vom_push_subscriptions')
        .select('id,vom_push_invites!inner(recipient_name,is_active)').eq('is_active',true).eq('vom_push_invites.is_active',true):{data:[],error:null};
      if(pde)throw new Error('operator_push_list_failed');
      return json(origin, {
        ok: true, actor, operators: (operators || []).map((op: any) => ({
          id: op.id, name: op.name, nickname: op.nickname, has_account: !!op.auth_user_id,
          ot_access: (accessRows || []).some((a: any) => a.member_id === op.id && a.user_id === op.auth_user_id && !a.revoked_at),
          push_devices:actor.isAdmin?(pushDevices||[]).filter((d:any)=>d.vom_push_invites?.recipient_name===op.name).length:undefined,
        })), invites, members,
        reviews: (reviews || []).map((r: any) => ({ ...r,
          profile:(()=>{const p=(profiles||[]).find((p:any)=>p.ot_room_invites?.review_id===r.id);if(!p)return null;const {profile_photo_path,ot_room_invites,...safe}=p;return {...safe,has_photo:!!profile_photo_path,approval_push_enabled:!!ot_room_invites.notification_push_enabled};})(),
          votes: (votes || []).filter((v: any) => v.review_id === r.id) })),
      });
    }

    if(action==='operator_push_invite'){
      if(!actor.isAdmin)throw new ApiError(403,'관리자만 운영진 알림 등록 링크를 발급할 수 있습니다.');
      const memberId=positiveInt(body.member_id);
      const {data:member,error:me}=await service.from('members').select('name').eq('id',memberId).eq('role','운영진').eq('is_active',true).maybeSingle();
      if(me||!member)throw new ApiError(400,'활동 중인 운영진을 선택해 주세요.');
      const {data:existing,error:ie}=await service.from('vom_push_invites').select('invite_token')
        .eq('recipient_name',member.name).eq('is_active',true).order('created_at',{ascending:false}).limit(1).maybeSingle();
      if(ie)throw new Error('operator_push_invite_lookup_failed');
      const token=existing?.invite_token||newToken();
      if(!existing){const {error}=await service.from('vom_push_invites').insert({recipient_name:member.name,invite_token:token,is_active:true});if(error)throw new Error('operator_push_invite_create_failed');}
      return json(origin,{ok:true,url:DEFAULT_ORIGIN+'/operator-alert/?t='+encodeURIComponent(token)});
    }

    if (action === "issue_invite") {
      const nickname = body.somoim_nickname ? textField(body.somoim_nickname, 80, "소모임 닉네임") : null;
      const token = newToken();
      const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const { data: invite, error } = await service.from("ot_room_invites").insert({
        token_hash: await tokenHash(token), somoim_nickname: nickname, issued_by: actor.userId, expires_at: expiresAt,
      }).select("id,somoim_nickname,expires_at").single();
      if (error) throw new Error("invite_create_failed");
      return json(origin, { ok: true, invite, url: DEFAULT_ORIGIN + "/ot-room/#token=" + token }, 201);
    }

    if (action === "revoke_invite") {
      if (typeof body.invite_id !== "string" || !/^[a-f0-9-]{36}$/.test(body.invite_id)) throw new ApiError(400, "등록 링크를 확인해 주세요.");
      const { data, error } = await service.from("ot_room_invites").update({ revoked_at: new Date().toISOString() })
        .eq("id", body.invite_id).is("revoked_at", null).select("id").maybeSingle();
      if (error) throw new Error("invite_revoke_failed");
      if (!data) throw new ApiError(404, "이미 중지됐거나 존재하지 않는 등록 링크입니다.");
      return json(origin, { ok: true });
    }

    if (action === "operator_access") {
      if (!actor.isAdmin) throw new ApiError(403, "OT 권한 관리는 관리자만 할 수 있습니다.");
      const memberId = positiveInt(body.member_id);
      const { data: operator, error } = await service.from("members").select("id,auth_user_id")
        .eq("id", memberId).eq("role", "운영진").eq("is_active", true).maybeSingle();
      if (error || !operator?.auth_user_id) throw new ApiError(400, "운영진의 본인 개인 계정 연결을 먼저 확인해 주세요.");
      if (body.enabled === true) {
        const { error: ge } = await service.from("ot_room_operator_access").upsert({
          user_id: operator.auth_user_id, member_id: memberId, granted_by: actor.userId,
          granted_at: new Date().toISOString(), revoked_at: null,
        }, { onConflict: "member_id" });
        if (ge) throw new Error("ot_access_grant_failed");
      } else if (body.enabled === false) {
        const { error: de } = await service.from("ot_room_operator_access").update({ revoked_at: new Date().toISOString() }).eq("member_id", memberId);
        if (de) throw new Error("ot_access_revoke_failed");
      } else throw new ApiError(400, "권한 부여 또는 회수를 선택해 주세요.");
      return json(origin, { ok: true });
    }

    if (action === "photo") {
      const reviewId=positiveInt(body.review_id);
      const {data:invitation,error:ie}=await service.from("ot_room_invites").select("id").eq("review_id",reviewId).maybeSingle();
      if (ie) throw new Error("photo_invite_lookup_failed");
      if (!invitation) throw new ApiError(404,"가입 정보를 찾지 못했습니다.");
      const {data:profile,error:pe}=await service.from("ot_room_applicants").select("profile_photo_path").eq("invite_id",invitation.id).maybeSingle();
      if (pe) throw new Error("photo_lookup_failed");
      const path=profile?.profile_photo_path;
      if (typeof path!=="string" || !/^profiles\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(jpg|png|webp)$/.test(path)) throw new ApiError(404,"등록된 본인사진이 없습니다.");
      const {data:photo,error:de}=await service.storage.from(VIDEO_BUCKET).download(path);
      if (de || !photo) throw new ApiError(404,"사진을 불러오지 못했습니다.");
      if (photo.size>5242880 || !["image/jpeg","image/png","image/webp"].includes(photo.type)) throw new ApiError(415,"지원하지 않는 사진입니다.");
      return new Response(photo,{headers:{...headers(origin),"Content-Type":photo.type,"Content-Length":String(photo.size),"Content-Disposition":"inline"}});
    }

    if(action==='media_link'){
      const reviewId=positiveInt(body.review_id);
      const {data:review,error}=await service.from('ot_reviews').select('video_source,video_url').eq('id',reviewId).maybeSingle();
      if(error)throw new Error('review_link_lookup_failed');
      if(!review||review.video_source!=='LINK')throw new ApiError(404,'등록된 라이브 링크가 없습니다.');
      return json(origin,{ok:true,url:mediaLink(review.video_url)});
    }

    if (action === "video" || action === "media") {
      const reviewId = positiveInt(body.review_id);
      const { data: review, error } = await service.from("ot_reviews").select("video_source,video_file_path").eq("id", reviewId).maybeSingle();
      if (error) throw new Error("review_lookup_failed");
      if (!review) throw new ApiError(404, "심사 건을 찾지 못했습니다.");
      if (review.video_source !== "FILE") throw new ApiError(409, "기존 외부 링크 자료는 관리자에게 확인해 주세요.");
      if (!/^reviews\/[a-zA-Z0-9_./-]+$/.test(review.video_file_path || "") || review.video_file_path.includes("..")) throw new ApiError(400, "영상 정보를 확인해 주세요.");
      const { data: video, error: de } = await service.storage.from(VIDEO_BUCKET).download(review.video_file_path);
      if (de || !video) throw new ApiError(404, "영상·음성을 불러오지 못했습니다.");
      const allowed = ["video/mp4","video/quicktime","video/webm","video/3gpp","audio/mp4","audio/mpeg","audio/aac","audio/wav","audio/x-wav","audio/ogg","audio/flac","audio/webm","audio/aiff"];
      if (video.size > 104857600 || !allowed.includes(video.type)) throw new ApiError(415, "지원하지 않는 영상·음성 자료입니다.");
      // Only authenticated fetch receives bytes. No signed/public Storage URL reaches the browser.
      return new Response(video, { headers: { ...headers(origin), "Content-Type": video.type, "Content-Length": String(video.size), "Content-Disposition": "inline" } });
    }

    if (action === "signed_video_url") throw new ApiError(410, "운영진 페이지에서 인증된 영상 재생을 이용해 주세요.");

    if (action === "vote") {
      const reviewId = positiveInt(body.review_id);
      const voterId = actor.isAdmin ? positiveInt(body.voter_member_id || actor.memberId) : actor.memberId;
      if (!voterId) throw new ApiError(403, "본인 운영진 계정을 연결해 주세요.");
      if (!actor.isAdmin && body.voter_member_id && Number(body.voter_member_id) !== voterId) throw new ApiError(403, "다른 운영진 명의로 의견을 남길 수 없습니다.");
      if (!["APPROVE", "REJECT", "HOLD"].includes(body.decision)) throw new ApiError(400, "심사 의견을 확인해 주세요.");
      const { data, error } = await service.rpc("vom_ot_record_vote", { p_review_id: reviewId, p_member_id: voterId, p_decision: body.decision, p_actor_id: actor.userId });
      if (error) throw new ApiError(409, "이미 확정됐거나 심사 대상이 변경됐습니다. 목록을 새로 확인해 주세요.");
      try {await notifyApproval(service,reviewId);} catch {console.error('Approval notification queued');}
      return json(origin, { ok: true, ...data });
    }

    if (action === "complete") {
      if (!actor.isAdmin) throw new ApiError(403, "최종 가입 연결은 관리자만 할 수 있습니다.");
      const reviewId = positiveInt(body.review_id);
      const memberId = positiveInt(body.member_id);
      const { data: member, error: me } = await service.from("members").select("id").eq("id", memberId).eq("is_active", true).maybeSingle();
      if (me || !member) throw new ApiError(400, "기존 MEMBERS에 등록된 가입 완료 회원을 선택해 주세요.");
      const { data, error } = await service.from("ot_reviews").update({
        completed_member_id: memberId, completed_at: new Date().toISOString(), completed_by: actor.userId,
      }).eq("id", reviewId).eq("status", "APPROVED").is("completed_at", null).select("id").maybeSingle();
      if (error) throw new Error("membership_link_failed");
      if (!data) throw new ApiError(409, "승인된 심사 건인지 확인해 주세요. 이미 연결된 가입 건은 변경되지 않습니다.");
      return json(origin, { ok: true });
    }

    if (action === "retry_notifications") {const operator=await notifyPendingOT(service),applicant=await notifyPendingApprovals(service);return json(origin,{ok:true,attempted:operator.attempted+applicant.attempted});}
    throw new ApiError(400, "지원하지 않는 요청입니다.");
  } catch (error) {
    return failure(origin, error);
  }
}

if (import.meta.main) Deno.serve((req: Request) => handle(req, createClient(
  Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  { auth: { persistSession: false, autoRefreshToken: false } },
)));
