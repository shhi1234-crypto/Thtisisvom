import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const SITE="https://thisisvom.vercel.app";
const steps=["CONSENT","NAME","BIRTH_YEAR","PHONE","NICKNAME","JOB","REGION","GENDER","EXPERIENCE","REASON","READY"] as const;
type Step=typeof steps[number];
const questions: Record<Step,string>={
  CONSENT:"VOM 가입을 위한 개인정보 수집·이용에 동의하시나요?\n수집: 실명, 출생연도, 연락처, 소모임 닉네임, 직업, 지역, 성별, 공연 경험, 가입 계기, 본인사진 및 심사 영상.\n목적: 가입 심사·회원 관리·탈퇴자 이력 관리. 운영진만 심사 자료를 확인합니다.\n채팅 중 미완료 자료는 최대 72시간 보관 후 삭제 대상입니다. 정식 접수된 정보·영상은 VOM 회원 관리 정책에 따릅니다. 동의하지 않으면 신청이 진행되지 않습니다.\n'동의합니다' 또는 '동의하지 않습니다'를 선택해 주세요.",
  NAME:"이름을 알려주세요. 다른 기본정보도 한 메시지에 함께 입력할 수 있어요.\n예: 김철수 / 1998년생 / 010-1234-5678 / 닉네임: 철수 / 버스킹 경험: 3회",
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

// Rules-based extraction: never invent or infer missing personal data.
// One message may contain several explicit fields; missing fields are requested separately.
// Flexible natural language can be supported later after privacy/cost review of an NLP provider.
type Extracted = Record<string,string>;
const labels:Record<string,Step>={
  "이름":"NAME","실명":"NAME","출생연도":"BIRTH_YEAR","출생년도":"BIRTH_YEAR","몇년생":"BIRTH_YEAR","년생":"BIRTH_YEAR",
  "전화번호":"PHONE","휴대폰":"PHONE","연락처":"PHONE","번호":"PHONE",
  "소모임닉네임":"NICKNAME","닉네임":"NICKNAME",
  "직업":"JOB","활동지역":"REGION","지역":"REGION","성별":"GENDER",
  "버스킹경험":"EXPERIENCE","공연경험":"EXPERIENCE","경험횟수":"EXPERIENCE","경험":"EXPERIENCE",
  "가입계기":"REASON","가입이유":"REASON","지원동기":"REASON"
};
const order:Step[]=["NAME","BIRTH_YEAR","PHONE","NICKNAME","JOB","REGION","GENDER","EXPERIENCE","REASON"];
function valueEnd(v:string){
  return v.trim().replace(/(?:이고요?|이구요|이에요|예요|입니다|라고\s*해요|라고\s*합니다|이고|이구|이에|이야|이에요|임)$/u,"").trim().replace(/[.!?]+$/,"").trim();
}
function canonicalLabel(raw:string){
  return labels[raw.replace(/\s+/g,"")]||null;
}
function labeledValues(text:string):Array<{step:Step,value:string}>{
  // Clearly labeled segments, including multi-line, comma, slash, pipe or semicolon input.
  const segments=text.split(/[,，;\n|/]+/g).map(v=>v.trim()).filter(Boolean);
  const found:Array<{step:Step,value:string}>=[];
  for(const segment of segments){
    const m=segment.match(/^(?:수정\s+)?(이름|실명|출생\s*연도|출생\s*년도|몇\s*년생|년생|전화번호|휴대폰|연락처|번호|소모임\s*닉네임|닉네임|직업|활동\s*지역|지역|성별|버스킹\s*경험|공연\s*경험|경험\s*횟수|경험|가입\s*계기|가입\s*이유|지원\s*동기)\s*(?:은|는|이|가|:|=|-)?\s*(.+)$/u);
    if(m){
      const step=canonicalLabel(m[1]);
      if(step)found.push({step,value:valueEnd(m[2])});
    }
  }
  return found;
}
function safePair(step:Step,raw:string,now:Date){
  let value=raw.trim();
  if(step==="BIRTH_YEAR"){
    const match=value.match(/^(\d{2}|\d{4})\s*(?:년생|년\s*출생)?$/u);
    if(!match)return null;
    if(match[1].length===2){
      const two=Number(match[1]),currentYear=Number(new Intl.DateTimeFormat("en",{timeZone:"Asia/Seoul",year:"numeric"}).format(now));
      value=String(two<=currentYear%100?2000+two:1900+two);
    }else value=match[1];
  }
  if(step==="EXPERIENCE"){
    const m=value.match(/^(\d{1,5})\s*(?:회|번)?(?:\s*(?:해봤어요|해봤습니다|있어요|있습니다))?$/u);
    if(!m)return null;value=m[1];
  }
  if(step==="GENDER"&&["남자","여자"].includes(value))value=value==="남자"?"남성":"여성";
  if(step==="NAME"||step==="NICKNAME"||step==="JOB"||step==="REGION")value=valueEnd(value);
  try{return validate(step,value,now);}catch{return null;}
}
export function extractAnswers(message:string,now=new Date()):Extracted {
  const text=message.trim().slice(0,1500);
  const entries=labeledValues(text);
  const candidate:Partial<Record<Step,string>>={};
  for(const {step,value} of entries) candidate[step]=value;
  // Natural-language markers: only high-confidence extraction.
  const phone=text.match(/(?:^|[^\d])((?:01[016789])[-.\s]?\d{3,4}[-.\s]?\d{4})(?!\d)/u);
  if(phone&&!candidate.PHONE)candidate.PHONE=phone[1].replace(/[.\s]/g,"-");
  const birth=text.match(/(?:^|[\s,])((?:19|20)\d{2}|\d{2})\s*년생(?:이|이고|이고요|이며|입니다)?/u);
  if(birth&&!candidate.BIRTH_YEAR)candidate.BIRTH_YEAR=birth[1];
  const firstName=text.match(/^([가-힣]{2,5})\s+(?:(?:19|20)?\d{2}\s*년생|전화번호|연락처)/u);
  const selfName=text.match(/(?:^|[\s,.])(?:저는|제\s*이름은|이름은|성함은)\s*([가-힣]{2,5})(?:이고|이며|입니다|이에요|예요|[,\s.!?]|$)/u);
  if(!candidate.NAME)candidate.NAME=selfName?.[1]||firstName?.[1];
  const nickname=text.match(/(?:소모임\s*)?닉네임(?:은|는|이|은요|:)?\s*([가-힣a-zA-Z0-9_]{1,40})(?:이고|이구요|입니다|이에요|예요|[,\s.!?]|$)/u);
  if(!candidate.NICKNAME&&nickname)candidate.NICKNAME=valueEnd(nickname[1]);
  const job=text.match(/직업(?:은|는|:)?\s*([가-힣a-zA-Z]{2,20})(?:이고|이며|입니다|이에요|예요|[,\s.!?]|$)/u);
  if(!candidate.JOB&&job)candidate.JOB=valueEnd(job[1]);
  const region=text.match(/(?:활동\s*)?지역(?:은|는|:)?\s*([가-힣]{2,15})(?:이고|이며|입니다|이에요|예요|[,\s.!?]|$)/u);
  if(!candidate.REGION&&region)candidate.REGION=valueEnd(region[1]);
  const gender=text.match(/성별(?:은|는|:)?\s*(남자|여자|남성|여성|기타)/u);
  if(!candidate.GENDER&&gender)candidate.GENDER=gender[1];
  const count=text.match(/(?:버스킹|공연)(?:\s*경험)?(?:은|는|을|은요|:)?[^\d\n,.]{0,22}?(\d{1,5})\s*(?:번|회)/u);
  if(!candidate.EXPERIENCE&&count)candidate.EXPERIENCE=count[1];
  // An explicit joining-reason clause is safe; otherwise ask instead of guessing.
  const reason=text.match(/(?:가입\s*(?:계기|이유)|지원\s*동기)(?:는|은|가|:)?\s*([^\n]{10,500})$/u);
  if(!candidate.REASON&&reason)candidate.REASON=valueEnd(reason[1]);
  if(!candidate.REASON){
    const sentences=text.split(/[.!?\n]+/u).map(x=>x.trim());
    const last=sentences[sentences.length-1]||sentences[sentences.length-2]||"";
    if(last.length>=12&&last.length<=500&&
       /(?:가입하려고|가입하고\s*싶|지원하게\s*됐|가입하게\s*됐)/u.test(last)&&
       !/(?:전화번호|연락처|닉네임|버스킹|공연\s*경험|출생연도)/u.test(last)){
      candidate.REASON=last;
    }
  }
  const answers:Extracted={};
  for(const step of order){
    const proposed=candidate[step];if(!proposed)continue;
    const normalized=safePair(step,proposed,now);
    if(normalized!==null)answers[profileKeys[step]]=normalized;
  }
  return answers;
}
const firstMissing=(answers:Extracted):Step|null=>order.find(step=>!answers[profileKeys[step]])||null;
function profileSummary(answers:Extracted){
  const phone=String(answers.phone||"");
  const masked=phone.length>=7?phone.slice(0,3)+"-****-"+phone.slice(-4):"확인 필요";
  const summary=[
    "이름: "+answers.candidate_name,"출생연도: "+answers.birth_year+"년",
    "전화번호: "+masked,"닉네임: "+answers.somoim_nickname,
    "직업: "+answers.job,"활동 지역: "+answers.region,"성별: "+answers.gender,
    "공연 경험: "+answers.busking_experience+"회",
    "가입 계기: "+String(answers.join_reason).slice(0,150)
  ].join("\n");
  return "입력한 정보를 확인해 주세요. 맞으면 '확인', 수정할 정보가 있으면 '수정 전화번호 010-...'처럼 보내 주세요.\n\n"+summary+
    "\n\n※ 영상 제출 전까지는 가입 신청이 접수되지 않습니다.";
}
function missingPrompt(step:Step,filled:Extracted){
  const count=order.filter(s=>filled[profileKeys[s]]).length;
  return "현재 "+count+"/9개 항목을 인식했습니다. 다른 항목도 한 메시지에 함께 적을 수 있어요.\n\n"+questions[step];
}

export function validate(step:Step,raw:string,now=new Date()):string{
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
      if(utterance.startsWith("수정 ")){
        const parsed=extractAnswers(utterance,now);
        if(!Object.keys(parsed).length)return result(msg("수정할 항목과 값을 함께 보내 주세요. 예: 수정 전화번호 010-1234-5678",["취소"]));
        const updated={...old.answers,...parsed};
        const missing=firstMissing(updated);
        const {data:saved,error}=await db.update({answers:updated,step:missing||"REVIEW",upload_token_hash:null,
          upload_expires_at:null,revision:old.revision+1,updated_at:now.toISOString()})
          .eq("id",old.id).eq("revision",old.revision).select("id").maybeSingle();
        if(error)throw error;
        return result(msg(saved?(missing?missingPrompt(missing,updated):profileSummary(updated)):"잠시 후 다시 시도해 주세요.",missing?["취소"]:["확인","취소"]));
      }
      if(utterance!=="영상 제출"&&utterance!=="가입 신청")return result(msg("영상 제출 준비가 완료됐습니다. '영상 제출' 버튼을 눌러 주세요.",["영상 제출","취소"]));
      const token=newToken();
      const {data:saved,error}=await db.update({upload_token_hash:await sha256(token),
        upload_expires_at:new Date(now.getTime()+60*60000).toISOString(),
        revision:old.revision+1,updated_at:now.toISOString()}).eq("id",old.id).eq("revision",old.revision).select("id").maybeSingle();
      if(error)throw error;
      if(!saved)return result(msg("다시 '영상 제출'을 눌러주세요.",["영상 제출"]));
      return result(uploadReply(SITE+"/kakao-video/?ticket="+token));
    }
    if(stage==="REVIEW"&&utterance==="확인"){
      const missing=firstMissing(old.answers||{});
      if(missing)return result(msg(missingPrompt(missing,old.answers||{}),["취소"]));
      const token=newToken();
      const {data:saved,error}=await db.update({step:"READY",upload_token_hash:await sha256(token),
        upload_expires_at:new Date(now.getTime()+60*60000).toISOString(),
        revision:old.revision+1,updated_at:now.toISOString()}).eq("id",old.id).eq("revision",old.revision).select("id").maybeSingle();
      if(error)throw error;
      return result(saved?uploadReply(SITE+"/kakao-video/?ticket="+token):msg("잠시 후 다시 시도해 주세요."));
    }
    if(!steps.includes(stage)&&stage!=="REVIEW")return result(msg("처음부터 다시 신청해 주세요.",["취소"]));
    if(stage==="REVIEW"&&utterance==="정보 확인"){
      return result(msg(profileSummary(old.answers),["확인","취소"]));
    }
    const parsed=extractAnswers(utterance,now);
    const implicitStep=stage==="REVIEW"?null:stage;
    if(!Object.keys(parsed).length&&implicitStep&&utterance!=="정보 확인"){
      // Preserve single-answer compatibility without mistaking a long free-form message for a name/job.
      try{
        const plain=validate(implicitStep,utterance,now);
        if(!["NAME","NICKNAME","JOB","REGION"].includes(implicitStep)||!/\s/.test(plain)){
          parsed[profileKeys[implicitStep]]=plain;
        }
      }catch{/* Ask only for fields which could not be parsed. */}
    }
    if(!Object.keys(parsed).length){
      const missing=firstMissing(old.answers||{});
      return result(msg(missing?missingPrompt(missing,old.answers||{}):profileSummary(old.answers||{}),
        missing?["정보 확인","취소"]:["확인","취소"]));
    }
    const updates:Extracted={...(old.answers||{}),...parsed};
    const missing=firstMissing(updates);
    const {data:saved,error}=await db.update({answers:updates,step:missing||"REVIEW",
      upload_token_hash:null,upload_expires_at:null,
      revision:old.revision+1,updated_at:now.toISOString()})
      .eq("id",old.id).eq("revision",old.revision).select("id").maybeSingle();
    if(error)throw error;
    return result(msg(saved?(missing?missingPrompt(missing,updates):profileSummary(updates)):"잠시 후 다시 시도해 주세요.",
      missing?["정보 확인","취소"]:["확인","취소"]));
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
