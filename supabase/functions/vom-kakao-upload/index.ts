import {createClient} from "npm:@supabase/supabase-js@2.117.2";
import {publicSignup} from "../_shared/public-signup.ts";
import {tokenHash,MAX_VIDEO_BYTES,MAX_PHOTO_BYTES,validatePhoto,validateVideo,DEFAULT_ORIGIN} from "../_shared/ot-core.ts";

const ORIGIN="https://thisisvom.vercel.app";
const MAX_BYTES=MAX_VIDEO_BYTES+MAX_PHOTO_BYTES+65536;
const headers={"Content-Type":"application/json; charset=utf-8",
 "Access-Control-Allow-Origin":ORIGIN,
 "Access-Control-Allow-Methods":"POST,OPTIONS",
 "Access-Control-Allow-Headers":"Content-Type,apikey",
 "Cache-Control":"no-store","Referrer-Policy":"no-referrer"};
const reply=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers});
const error=(detail:string,status=400)=>reply({ok:false,error:detail},status);
const text=(v:unknown)=>typeof v==="string"?v:"";
function safeTicket(ticket:unknown):ticket is string{
 return typeof ticket==="string"&&/^[a-f0-9]{64}$/.test(ticket);
}
export async function handle(req:Request,service:any){
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.headers.get("origin")!==ORIGIN)return error("허용되지 않은 요청입니다.",403);
 if(req.method!=="POST")return error("지원하지 않는 요청입니다.",405);
 const contentType=req.headers.get("content-type")||"";
 if(Number(req.headers.get("content-length")||0)>MAX_BYTES)return error("첨부 파일 용량을 확인해 주세요.",413);
 let fields:Record<string,any>|null=null;
 if(contentType.startsWith("application/json")){
   try{fields=await req.json();}catch{return error("요청 내용을 확인해 주세요.");}
 }else if(contentType.startsWith("multipart/form-data;")){
   try {
     const form=await req.formData();
     fields=Object.fromEntries(form);
   }catch{return error("파일을 읽지 못했습니다.");}
 }else return error("지원하지 않는 요청입니다.",415);
 const ticket=fields?.ticket;
 if(!safeTicket(ticket))return error("영상 등록 링크가 유효하지 않습니다.",403);
 const hash=await tokenHash(ticket);
 const now=new Date().toISOString();
 const {data:draft,error:lookupError}=await service.from("kakao_signup_drafts")
   .select("id,step,answers,consent_version,consented_at,upload_expires_at,revision,completed_at")
   .eq("upload_token_hash",hash).maybeSingle();
 if(lookupError)return error("신청 정보를 확인하지 못했습니다.",500);
 if(!draft||draft.step!=="READY"||!draft.consented_at||
   !draft.upload_expires_at||draft.upload_expires_at<=now||draft.completed_at)
   return error("영상 제출 링크가 만료됐습니다. 카카오톡에서 '영상 제출'을 다시 눌러주세요.",403);
 if(fields?.action==="status")return reply({ok:true,ready:true,
   requirements:{photo_max_mb:5,video_max_mb:50,live_min_seconds:30}});
 if(!contentType.startsWith("multipart/form-data;"))return error("파일 제출 요청이 아닙니다.");
 const photo=fields?.photo,video=fields?.video;
 if(!(photo instanceof File)||!(video instanceof File))return error("본인 사진과 라이브 영상을 모두 첨부해 주세요.");
 if(photo.size>MAX_PHOTO_BYTES||video.size>MAX_VIDEO_BYTES||photo.size<1||video.size<1)
   return error("사진은 5MB, 라이브 영상은 50MB 이하여야 합니다.");
 try{await validatePhoto(photo);await validateVideo(video);}
 catch{return error("사진 또는 영상 형식을 확인해 주세요.");}
 if(fields?.consent!=="yes"||fields?.live_confirmed!=="yes")
   return error("영상 심사 동의 및 라이브 자료 확인이 필요합니다.");
 if(!/^\d{4}$/.test(text(fields.password))||fields.password!==fields.password_confirm)
   return error("MY VOM 숫자 4자리 비밀번호와 확인 입력이 일치해야 합니다.");
 const {data:claimed,error:claimError}=await service.from("kakao_signup_drafts")
   .update({step:"SUBMITTING",revision:draft.revision+1,updated_at:now})
   .eq("id",draft.id).eq("revision",draft.revision).eq("step","READY")
   .select("id").maybeSingle();
 if(claimError)return error("접수 준비를 확인하지 못했습니다.",500);
 if(!claimed)return error("이미 접수 중입니다. 운영진에게 문의해 주세요.",409);
 const answers=draft.answers||{};
 // Only validated answers from the private draft are passed into the existing public OT workflow.
 const mapped:Record<string,string>={
   candidate_name:text(answers.candidate_name),birth_year:text(answers.birth_year),
   phone:text(answers.phone),somoim_nickname:text(answers.somoim_nickname),
   job:text(answers.job),region:text(answers.region),gender:text(answers.gender),
   busking_experience:text(answers.busking_experience),busking_experience_unit:"COUNT",
   password:text(fields.password),password_confirm:text(fields.password_confirm),
   consent:"yes",live_confirmed:"yes",media_source:"FILE"
 };
 const form=new FormData();
 for(const [key,value] of Object.entries(mapped))form.append(key,value);
 form.append("photo",photo,photo.name);
 form.append("video",video,video.name);
 const forward=new Request("https://internal.vom.invalid/functions/v1/ot-room?signup=public",{
   method:"POST",headers:{"Origin":DEFAULT_ORIGIN},body:form
 });
 try {
   const received=await publicSignup(forward,service,DEFAULT_ORIGIN);
   const receipt=await received.json();
   if(!received.ok||!receipt?.ok){
     // Pre-commit errors are retriable, but do not retry automatically: upstream may have committed.
     await service.from("kakao_signup_drafts").update({step:"NEEDS_REVIEW",updated_at:new Date().toISOString()})
       .eq("id",draft.id).eq("step","SUBMITTING");
     return error("가입 접수 결과를 확인하지 못했습니다. 중복 제출하지 말고 운영진에게 문의해 주세요.",409);
   }
   // Bind the new '가입 계기' to this exact invite through the one-time token issued
   // by the existing signup workflow; no matching by applicant names or phone numbers.
   let reasonRecorded=false;
   if(typeof receipt.notification_token==="string"){
     const {data:invite, error:inviteErr}=await service.from("ot_room_invites")
       .select("applicant_user_id").eq("notification_token_hash",
         await tokenHash(receipt.notification_token)).maybeSingle();
     if(!inviteErr&&invite?.applicant_user_id){
       const reason=text(answers.join_reason).trim().slice(0,500);
       const {error:updateErr}=await service.from("ot_room_applicants")
         .update({join_reason:reason}).eq("auth_user_id",invite.applicant_user_id);
       reasonRecorded=!updateErr;
     }
   }
   await service.from("kakao_signup_drafts").delete().eq("id",draft.id);
   // Sensitive access token returned only to same-origin submitter; not to Kakao chat.
   return reply({ok:true,submitted:true,status:receipt.status,
     scheduled_at:receipt.scheduled_at||null,
     check_at:receipt.check_at||null,
     message:receipt.message||"가입 신청이 접수되었습니다.",
     reason_recorded:reasonRecorded,
     notification_token:receipt.notification_token||null});
 }catch(e){
   console.error("kakao_ot_upload_failed",e instanceof Error?e.name:"unknown");
   // Leave unverified downstream commit in NEEDS_REVIEW instead of double-submitting.
   await service.from("kakao_signup_drafts").update({step:"NEEDS_REVIEW",updated_at:new Date().toISOString()})
     .eq("id",draft.id).eq("step","SUBMITTING");
   return error("접수 결과를 확인하지 못했습니다. 중복 제출하지 말고 운영진에게 문의해 주세요.",500);
 }
}
if(import.meta.main){
 const service=createClient(Deno.env.get("SUPABASE_URL")||"",
   Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",
   {auth:{autoRefreshToken:false,persistSession:false}});
 Deno.serve(req=>handle(req,service));
}
