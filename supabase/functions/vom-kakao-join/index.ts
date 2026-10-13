import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const SITE="https://thisisvom.vercel.app";
const steps=["CONSENT","NAME","BIRTH_YEAR","PHONE","NICKNAME","JOB","REGION","GENDER","EXPERIENCE","REASON","READY"] as const;
type Step=typeof steps[number];
const questions: Record<Step,string>={
  CONSENT:"VOM 가입을 위한 개인정보 수집·이용에 동의하시나요?\n수집: 실명, 출생연도, 연락처, 소모임 닉네임, 직업, 지역, 성별, 공연 경험, 가입 계기, 본인사진 및 심사 영상.\n목적: 가입 심사·회원 관리·탈퇴자 이력 관리. 운영진만 심사 자료를 확인합니다.\n채팅 중 미완료 자료는 최대 72시간 보관 후 삭제 대상입니다. 정식 접수된 정보·영상은 VOM 회원 관리 정책에 따릅니다. 동의하지 않으면 신청이 진행되지 않습니다.\n'동의합니다' 또는 '동의하지 않습니다'를 선택해 주세요.",
  NAME:"1/9 본인 실명을 성까지 포함해 입력해 주세요. (예: 김철수)",
  BIRTH_YEAR:"2/9 태어난 연도 4자리를 입력해 주세요. (예: 1998)",
  PHONE:"3/9 연락 가능한 휴대폰 번호를 입력해 주세요. (예: 010-1234-5678)",
  NICKNAME:"4/9 소모임에서 쓰는 닉네임을 입력해 주세요. (가입·탈퇴 이력 확인용)",
  JOB:"5/9 직업을 입력해 주세요. (예: 회사원, 대학생)",
  REGION:"6/9 활동 지역을 입력해 주세요. (예: 인천, 부천)",
  GENDER:"7/9 성별을 입력해 주세요. (남성 / 여성 / 기타)",
  EXPERIENCE:"8/9 버스킹·공연 경험 횟수를 숫자로 입력해 주세요. (경험 없으면 0)",
  REASON:"9/9 VOM에 가입하게 된 계기를 자유롭게 입력해 주세요. (10~500자)",
  READY:"기본정보 입력이 끝났습니다. 아래 '영상·사진 제출' 버튼에서 본인 사진, 30초 이상 무보정 라이브 영상과 MY VOM 비밀번호를 제출하면 가입 심사에 자동 접수됩니다. 같은 정보를 다시 입력할 필요는 없습니다."
};
const options=(items:string[])=>items.map(label=>({label,action:"message",messageText:label}));
const msg=(text:string,quick:string[]=[])=>({version:"2.0",template:{outputs:[{simpleText:{text}}],quickReplies:options(quick)}});
const uploadReply=(url:string)=>({version:"2.0",template:{
  outputs:[{textCard:{title:"VOM 가입 · 영상 제출 🎬",description:questions.READY,
    buttons:[{label:"영상·사진 제출",action:"webLink",webLinkUrl:url}]}}],
  quickReplies:options(["영상 제출","취소"])
}});
const profileKeys:Record<string,string>={
 NAME:"candidate_name",BIRTH_YEAR:"birth_year",PHONE:"phone",NICKNAME:"somoim_nickname",
 JOB:"job",REGION:"region",GENDER:"gender",EXPERIENCE:"busking_experience",REASON:"join_reason"
};
const next:Record<string,Step>={NAME:"BIRTH_YEAR",BIRTH_YEAR:"PHONE",PHONE:"NICKNAME",
 NICKNAME:"JOB",JOB:"REGION",REGION:"GENDER",GENDER:"EXPERIENCE",EXPERIENCE:"REASON",REASON:"READY"};
function validate(step:Step,raw:string,now=new Date()):string{
  const v=raw.trim().replace(/[\x00-\x1f\x7f]/g," ");
  if(step==="NAME"){if(v.length<2||v.length>60||!/^[\p{L}\s.'-]+$/u.test(v))throw Error("성함을 정확히 입력해 주세요.");}
  if(step==="BIRTH_YEAR"){const year=Number(v),currentYear=Number(new Intl.DateTimeFormat("en",{timeZone:"Asia/Seoul",year:"numeric"}).format(now));if(!/^\d{4}$/.test(v)||year<1900||year>currentYear)throw Error("출생연도 4자리를 입력해 주세요.");}
  if(step==="PHONE"){if(!/^01[016789]-?\d{3,4}-?\d{4}$/.test(v))throw Error("010-1234-5678 형식으로 연락처를 입력해 주세요.");return v.replace(/-/g,"");}
  if(["NICKNAME","JOB","REGION"].includes(step)){if(v.length<1||v.length>(step==="NICKNAME"?80:80))throw Error("80자 이내로 답변해 주세요.");}
  if(step==="GENDER"&&!["남성","여성","기타"].includes(v))throw Error("남성, 여성, 기타 중 하나를 입력해 주세요.");
  if(step==="EXPERIENCE"&&(!/^\d{1,5}$/.test(v)||Number(v)>10000))throw Error("공연 경험 횟수는 0~10000 사이 숫자로 적어 주세요.");
  if(step==="REASON"&&(v.length<10||v.length>500))throw Error("가입 계기를 10~500자로 입력해 주세요.");
  return v;
}
async function hmac(key:string,data:string) {
  const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(key),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const h=await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(data));
  return Array.from(new Uint8Array(h),b=>b.toString(16).padStart(2,"0")).join("");
}
async function sha256(data:string){
  const buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf),b=>b.toString(16).padStart(2,"0")).join("");
}
function newToken(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");}
function result(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});}
function authOK(req:Request,secret:string){
  const header=req.headers.get("x-vom-kakao-secret")||"";
  // Kakao custom header support must be verified in builder before enabling collection.
  return secret.length>=32 && header.length===secret.length &&
    header.split("").every((c,i)=>c===secret[i]);
}
export async function handle(req:Request,service:any,secret:string){
  if(req.method!=="POST")return result(msg("지원하지 않는 요청입니다."),405);
  if(!authOK(req,secret))return result(msg("가입 챗봇 연결 준비 중입니다. 당분간 VOM 홈페이지에서 신청해 주세요: "+SITE+"/ot-room/"),403);
  try{
    const raw=await req.text();if(raw.length>16384)return result(msg("요청이 너무 깁니다."),413);
    const payload=JSON.parse(raw);
    const user=payload?.userRequest?.user?.id,bot=payload?.bot?.id;
    if(typeof user!=="string"||user.length<6||user.length>256||
       typeof bot!=="string"||bot.length<4||bot.length>256)return result(msg("채널 사용자 정보를 확인하지 못했습니다."));
    const utterance=String(payload?.userRequest?.utterance??"").trim().slice(0,650);
    const key=await hmac(secret,"VOM-KAKAO-BOT:"+bot+"::"+user);
    const db=service.from("kakao_signup_drafts");
    const now=new Date();
    const {data:old,error:readErr}=await db.select("*").eq("bot_user_hash",key).maybeSingle();
    if(readErr)throw readErr;
    if(utterance==="취소"||utterance==="가입 취소"){
      if(old)await db.delete().eq("id",old.id);
      return result(msg("입력 중이던 가입 정보를 삭제했습니다. 다시 신청하려면 '가입 신청'을 입력해 주세요.",["가입 신청"]));
    }
    if(!old||old.expires_at<=now.toISOString()||old.completed_at){
      if(old){await db.delete().eq("id",old.id);}
      if(!["가입 신청","가입하기","회원가입","시작","동의합니다"].includes(utterance)){
        return result(msg("VOM 가입을 시작하려면 '가입 신청'을 눌러 주세요.",["가입 신청"]));
      }
      const {error:ins}=await db.insert({bot_user_hash:key,step:"CONSENT",answers:{},expires_at:new Date(now.getTime()+72*3600e3).toISOString()});
      if(ins)throw ins;
      return result(msg(questions.CONSENT,["동의합니다","동의하지 않습니다","취소"]));
    }
    const stage=old.step as Step;
    if(stage==="CONSENT"){
      if(utterance==="동의하지 않습니다") {
        await db.delete().eq("id",old.id);
        return result(msg("동의하지 않아 가입 신청을 중단했습니다.",["가입 신청"]));
      }
      if(utterance!=="동의합니다")return result(msg(questions.CONSENT,["동의합니다","동의하지 않습니다","취소"]));
      const {data:saved,error}=await db.update({step:"NAME",consent_version:"KAKAO_OT_V1",consented_at:now.toISOString(),
        revision:old.revision+1,updated_at:now.toISOString()}).eq("id",old.id).eq("revision",old.revision).select("id").maybeSingle();
      if(error)throw error;
      return result(msg(saved?questions.NAME:"잠시 후 다시 시도해 주세요.",["취소"]));
    }
    if(stage==="READY"){
      if(utterance!=="영상 제출"&&utterance!=="가입 신청"){
        return result(msg("기본정보 입력이 완료됐습니다. '영상 제출'을 눌러주세요.",["영상 제출","취소"]));
      }
      const token=newToken();
      const {data:saved,error}=await db.update({upload_token_hash:await sha256(token),
        upload_expires_at:new Date(now.getTime()+60*60000).toISOString(),
        revision:old.revision+1,updated_at:now.toISOString()}).eq("id",old.id).eq("revision",old.revision).select("id").maybeSingle();
      if(error)throw error;
      if(!saved)return result(msg("다시 '영상 제출'을 눌러주세요.",["영상 제출"]));
      return result(uploadReply(SITE+"/kakao-video/?ticket="+token));
    }
    if(!steps.includes(stage))return result(msg("처음부터 다시 신청해 주세요.",["취소"]));
    let answer:string;
    try{answer=validate(stage,utterance,now);}catch(e:any){return result(msg(e.message+"\n"+questions[stage],["취소"]));}
    const updates:any={answers:{...old.answers,[profileKeys[stage]]:answer},
      step:next[stage],revision:old.revision+1,updated_at:now.toISOString()};
    if(stage==="REASON"){
      const token=newToken();
      updates.upload_token_hash=await sha256(token);
      updates.upload_expires_at=new Date(now.getTime()+60*60000).toISOString();
      const {data:saved,error}=await db.update(updates).eq("id",old.id).eq("revision",old.revision).select("id").maybeSingle();
      if(error)throw error;
      return result(saved?uploadReply(SITE+"/kakao-video/?ticket="+token):msg("다시 시도해 주세요."));
    }
    const {data:saved,error}=await db.update(updates).eq("id",old.id).eq("revision",old.revision).select("id").maybeSingle();
    if(error)throw error;
    return result(msg(saved?questions[next[stage]]:"잠시 후 다시 시도해 주세요.",["취소"]));
  }catch(e){
    // No raw request bodies, user IDs, phone numbers, or secrets in logs.
    console.error("kakao_signup_chat_failed",e instanceof Error?e.name:"error");
    return result(msg("가입 정보를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."),500);
  }
}
if(import.meta.main){
  const url=Deno.env.get("SUPABASE_URL")||"";
  const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  const secret=Deno.env.get("VOM_KAKAO_CHAT_SECRET")||"";
  Deno.serve(req=>handle(req,createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}}),secret));
}
