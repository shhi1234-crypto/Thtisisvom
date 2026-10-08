import { ApiError, VIDEO_BUCKET, MAX_VIDEO_BYTES, MAX_PHOTO_BYTES, signupDetails, validatePhoto, validateVideo, isRegistrationOpen, textField, tokenHash, newToken, validToken, json } from './ot-core.ts';
import { applicantEmail, loginName, signupPassword } from './member-access.ts';
import { notifyOT, notifyApproval } from './ot-push.ts';
import { nextRegistrationAt } from './signup-reservations.ts';

export function approvalSubscription(value: any) {
  let url: URL;
  try { url=new URL(value?.endpoint); } catch { throw new ApiError(400,'휴대폰 알림 정보를 확인해 주세요.'); }
  const host=url.hostname;
  const vendor=host==='fcm.googleapis.com' || host==='updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') || host==='web.push.apple.com' || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
  if (!vendor || url.protocol!=='https:' || (url.port && url.port!=='443') || url.username || url.password || url.href.length>2048) throw new ApiError(400,'지원하지 않는 휴대폰 알림 주소입니다.');
  const p256dh=value?.keys?.p256dh,auth=value?.keys?.auth;
  if (typeof p256dh!=='string' || !/^[A-Za-z0-9_-]{87}=?$/.test(p256dh) || typeof auth!=='string' || !/^[A-Za-z0-9_-]{22}={0,2}$/.test(auth)) throw new ApiError(400,'휴대폰 알림 인증 정보를 확인해 주세요.');
  return {endpoint:url.href,p256dh,auth};
}

export async function publicSignup(req: Request, service: any, origin: string, now=()=>new Date()) {
  let createdUser: string|null=null,inviteId: string|null=null,committed=false,scheduledAt:string|null=null,submittedAt:string|null=null,checkAt:string|null=null;
  const paths:string[]=[];
  try {
    if (!(req.headers.get('content-type')||'').startsWith('multipart/form-data;')) {
      let body;try {body=await req.json();}catch {throw new ApiError(400,'요청 내용을 확인해 주세요.');}
      if (body.action==='info') return json(origin,{ok:true,public_signup:true,server_time:now().toISOString(),registration_open:isRegistrationOpen(now()),scheduled_at:nextRegistrationAt(now())});
      if (body.action!=='subscribe_approval' || !validToken(body.notification_token)) throw new ApiError(400,'신청 완료 화면에서 승인 알림을 등록해 주세요.');
      const subscription=approvalSubscription(body.subscription);
      const {data:invite,error}=await service.from('ot_room_invites').select('id,review_id,notification_expires_at,revoked_at').eq('notification_token_hash',await tokenHash(body.notification_token)).maybeSingle();
      if (error) throw new Error('approval_subscription_lookup_failed');
      if (!invite || invite.revoked_at || !invite.notification_expires_at || new Date(invite.notification_expires_at)<=now()) throw new ApiError(403,'알림 등록 기간이 지났습니다. 소모임 운영진에게 안내받아 주세요.');
      if (!invite.review_id) {
        const {data:reservation,error:lookupError}=await service.from('ot_signup_reservations').select('invite_id').eq('invite_id',invite.id).in('status',['WAITING','PROCESSING']).maybeSingle();
        if (lookupError) throw new Error('reservation_subscription_lookup_failed');
        if (!reservation) throw new ApiError(403,'가입 신청 완료 화면에서 알림을 등록해 주세요.');
      }
      const {error:se}=await service.from('ot_applicant_push_subscriptions').upsert({invite_id:invite.id,...subscription,is_active:true,updated_at:now().toISOString()},{onConflict:'invite_id'});
      if (se) throw new Error('approval_subscription_save_failed');
      const {error:ue}=await service.from('ot_room_invites').update({notification_push_enabled:true}).eq('id',invite.id);
      if (ue) throw new Error('approval_subscription_enable_failed');
      try {if(invite.review_id)await notifyApproval(service,Number(invite.review_id));}catch {console.error('Approval notification queued');}
      return json(origin,{ok:true,message:'승인 알림을 등록했습니다.'});
    }
    const limit=MAX_VIDEO_BYTES+MAX_PHOTO_BYTES+64*1024;
    if (Number(req.headers.get('content-length')||0)>limit) throw new ApiError(413,'본인사진은 5MB, 라이브 파일은 50MB 이하로 선택해 주세요.');
    if (!req.body) throw new ApiError(400,'회원가입 신청 내용을 읽지 못했습니다.');
    let received=0,oversized=false,form:FormData;
    const stream=req.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){received+=chunk.byteLength;if(received>limit){oversized=true;throw new Error('signup_size_limit');}controller.enqueue(chunk);}}));
    try {form=await new Response(stream,{headers:{'Content-Type':req.headers.get('content-type')||''}}).formData();}catch {throw new ApiError(oversized?413:400,oversized?'본인사진과 라이브 파일의 용량을 확인해 주세요.':'회원가입 신청 내용을 읽지 못했습니다.');}
    const fields=Object.fromEntries(form);
    if (fields.consent!=='yes') throw new ApiError(400,'가입 정보와 제출 자료의 수집·검토에 동의해 주세요.');
    if (fields.password!==fields.password_confirm) throw new ApiError(400,'비밀번호 확인이 일치하지 않습니다.');
    const name=loginName(fields.login_name),password=signupPassword(fields.password);
    const profile:any={...signupDetails(fields,now()),login_name:name,candidate_name:textField(fields.candidate_name,60,'이름'),somoim_nickname:textField(fields.somoim_nickname,80,'소모임 닉네임')};
    for (const [key,max,label] of [['phone',30,'연락처'],['region',80,'활동 지역'],['gender',20,'성별']] as const) profile[key]=textField(fields[key],max,label);
    const photo=form.get('photo'),media=form.get('video');
    if (!(photo instanceof File) || !(media instanceof File)) throw new ApiError(400,'본인사진과 라이브 영상 또는 음성 파일을 모두 선택해 주세요.');
    const photoType=await validatePhoto(photo),mediaType=await validateVideo(media);
    const {data:created,error:ce}=await service.auth.admin.createUser({email:await applicantEmail(name),password,email_confirm:true});
    if (ce || !created.user) throw new ApiError(409,'사용할 수 없는 아이디입니다. 다른 아이디를 입력해 주세요.');
    createdUser=created.user.id;
    inviteId=crypto.randomUUID();
    const claimId=crypto.randomUUID(),notificationToken=newToken();
    const {error:ie}=await service.from('ot_room_invites').insert({id:inviteId,token_hash:await tokenHash(newToken()),issued_by:createdUser,somoim_nickname:profile.somoim_nickname,signup_source:'PUBLIC',expires_at:new Date(now().getTime()+7*86400000).toISOString(),account_claim_id:claimId,account_claimed_at:now().toISOString(),notification_token_hash:await tokenHash(notificationToken),notification_expires_at:new Date(now().getTime()+14*86400000).toISOString()});
    if (ie) throw new Error('public_signup_record_failed');
    const {error:be}=await service.rpc('vom_ot_bind_account',{p_invite_id:inviteId,p_claim_id:claimId,p_user_id:createdUser,p_profile:profile});
    if (be) throw new Error('public_signup_bind_failed');
    for (const [file,type,isPhoto] of [[photo,photoType,true],[media,mediaType,false]] as const) {
        const uploadClaim=crypto.randomUUID(),path=`${isPhoto?'profiles':'reviews'}/${inviteId}/${uploadClaim}.${type.extension}`;
      const {data:reserved,error:re}=await service.from('ot_room_invites').update({upload_claim_id:uploadClaim,upload_claimed_at:now().toISOString()}).eq('id',inviteId).is('review_id',null).is('upload_claim_id',null).select('id').maybeSingle();
      if (re || !reserved) throw new Error('public_signup_upload_claim_failed');
      paths.push(path);
      const {error:ue}=await service.storage.from(VIDEO_BUCKET).upload(path,file.slice(0,file.size,type.mime),{contentType:type.mime,cacheControl:'0',upsert:false});
      if (ue) throw new Error('public_signup_file_upload_failed');
        const args:any={p_invite_id:inviteId,p_claim_id:uploadClaim,p_file_path:path,p_file_name:file.name.replace(/[\x00-\x1f\x7f]/g,'').slice(0,180)};
      if (!isPhoto) Object.assign(args,{p_candidate_name:profile.candidate_name,p_somoim_nickname:profile.somoim_nickname});
      let data:any=null,fe:any=null;
      const reserve=async()=>{
        const result=await service.rpc('vom_ot_reserve_upload',{p_invite_id:inviteId,p_claim_id:uploadClaim,p_file_path:path,p_file_name:args.p_file_name});
        if(result.error)throw new ApiError(409,'예약 결과를 확인하지 못했습니다. 운영진에게 접수 여부를 확인해 주세요.');
        if(!result.data?.scheduled_at)throw new Error('reservation_receipt_missing');
        scheduledAt=result.data.scheduled_at;committed=true;
      };
      if(!isPhoto&&!isRegistrationOpen(now()))await reserve();
      else {
        ({data,error:fe}=await service.rpc(isPhoto?'vom_ot_finalize_photo':'vom_ot_finalize_upload',args));
        if(fe&&!isPhoto&&fe.message?.includes('room_closed'))await reserve();
        else if(fe)throw new ApiError(409,'신청 결과를 확인하지 못했습니다. 운영진에게 접수 여부를 확인해 주세요.');
        else if(!isPhoto){
          committed=true;
          submittedAt=data?.submitted_at||null;checkAt=data?.check_at||null;
          const reviewId=Number(Array.isArray(data)?data[0]?.id:data?.id);
          if(reviewId)try{await notifyOT(service,reviewId);}catch{console.error('OT notification queued');}
        }
      }
    }
    const {data:config}=await service.from('vom_push_config').select('vapid_public_key').eq('id',1).maybeSingle();
    return json(origin,{ok:true,submitted:true,status:scheduledAt?'SCHEDULED':'IN_REVIEW',scheduled_at:scheduledAt,submitted_at:submittedAt,check_at:checkAt||(scheduledAt?new Date(Date.parse(scheduledAt)+3*3600000).toISOString():null),notification_token:notificationToken,push_public_key:config?.vapid_public_key||null,message:scheduledAt?'신청이 예약됐습니다. 익일 오전 9시에 자동 접수되며 승인 후 로그인할 수 있습니다.':'회원가입 신청이 접수됐습니다. 정식 접수 후 3시간 이후 가입 결과를 직접 확인해 주세요. 검토 중이면 익일 안내될 수 있습니다.'},201);
  } finally {
    if (createdUser && !committed) {
      try {
        // A lost RPC response must never remove a committed review or its media.
        const {data:current,error}=inviteId?await service.from('ot_room_invites').select('review_id').eq('id',inviteId).maybeSingle():{data:null,error:null};
        const reserved=inviteId?await service.from('ot_signup_reservations').select('invite_id').eq('invite_id',inviteId).maybeSingle():{data:null,error:null};
        if (!error && !reserved.error && !current?.review_id && !reserved.data) {
          if (paths.length) await service.storage.from(VIDEO_BUCKET).remove(paths);
          if (inviteId) {
            await service.from('ot_room_applicants').delete().eq('invite_id',inviteId).eq('auth_user_id',createdUser);
            await service.from('ot_room_invites').delete().eq('id',inviteId).is('review_id',null);
          }
          await service.auth.admin.deleteUser(createdUser);
        }
      }catch {console.error('Public signup reconciliation deferred');}
    }
  }
}
