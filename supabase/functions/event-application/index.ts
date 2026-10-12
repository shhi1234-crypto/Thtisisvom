import {createClient} from 'npm:@supabase/supabase-js@2.117.2';
const URL_=Deno.env.get('SUPABASE_URL')||'';
const KEY_=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const origins=['https://thisisvom.vercel.app','https://www.thisisvom.vercel.app'];
const headers=(origin:string)=>({'Content-Type':'application/json','Access-Control-Allow-Origin':origins.includes(origin)?origin:origins[0],'Access-Control-Allow-Headers':'authorization, content-type, apikey','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Vary':'Origin'});
const reply=(origin:string,body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:headers(origin)});
function err(message:string,status:number):never {throw Object.assign(new Error(message),{status});}
function numberId(value:any){const id=Number(value);if(!Number.isSafeInteger(id)||id<=0)err('올바른 일정 번호를 선택해 주세요.',400);return id;}
function errorText(error:any){const detail=String(error?.message||'');const map:Record<string,string>={
  applications_not_enabled:'아직 홈페이지 신청을 받지 않는 일정입니다.',
  applications_not_open:'참가 신청 오픈 전입니다.',
  applications_closed:'참가 신청이 마감됐습니다.',
  applications_full:'신청 정원이 마감됐습니다.',
  application_not_found:'취소할 참가 신청이 없습니다.',
  event_not_found:'일정을 찾을 수 없습니다.',
  member_not_active:'활동 회원만 신청할 수 있습니다.',
  refund_pending:'환불 처리 중에는 다시 신청할 수 없습니다. 운영진에게 문의해 주세요.'};
  return Object.entries(map).find(([key])=>detail.includes(key))?.[1]||'요청을 처리하지 못했습니다. 다시 시도해 주세요.';
}
export async function handle(req:Request,service:any){
  const origin=req.headers.get('Origin')||origins[0];
  if(req.headers.has('Origin')&&!origins.includes(origin))return reply(origins[0],{error:'허용되지 않은 요청입니다.'},403);
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:headers(origin)});
  if(req.method!=='POST')return reply(origin,{error:'지원하지 않는 요청입니다.'},405);
  try{
    const body=await req.json();
    if(!['view','apply','cancel','admin_list','confirm','unconfirm','payment_config','mark_paid','mark_unpaid','refund_complete'].includes(body?.action))err('지원하지 않는 요청입니다.',400);
    const eventId=numberId(body.event_id);
    const token=req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if(!token)err('로그인 후 이용해 주세요.',401);
    const {data:userData,error:userError}=await service.auth.getUser(token);
    if(userError||!userData.user)err('로그인 정보를 다시 확인해 주세요.',401);
    const userId=userData.user.id;
    const {data:member,error:me}=await service.from('members').select('id,name,is_active').eq('auth_user_id',userId).maybeSingle();
    if(me)throw me;
    const {data:admin,error:ae}=await service.from('admins').select('user_id').eq('user_id',userId).maybeSingle();
    if(ae)throw ae;
    const isAdmin=!!admin;
    if(!member?.is_active&&!isAdmin)err('가입 승인된 활동 회원만 이용할 수 있습니다.',403);
    const {data:event,error:ee}=await service.from('events').select('id,title,event_date,start_time,location,event_type,application_enabled,application_capacity,application_opens_at,application_closes_at').eq('id',eventId).maybeSingle();
    if(ee)throw ee;
    if(!event)err('일정을 찾을 수 없습니다.',404);
    if(event.event_date<'2026-11-01'&&!isAdmin)err('11월 이후 일정부터 신청할 수 있습니다.',403);
    if(['admin_list','confirm','unconfirm','payment_config','mark_paid','mark_unpaid','refund_complete'].includes(body.action)&&!isAdmin)err('운영진 관리 권한이 없습니다.',403);
    const {data:payment,error:paymentError}=await service.from('event_payment_settings')
      .select('fee_won,payment_instructions,refund_instructions,payment_due_at')
      .eq('event_id',eventId).maybeSingle();
    if(paymentError)throw paymentError;
    if(body.action==='payment_config'){
      if(event.event_date<'2026-11-01')err('11월 이후 일정에만 참가비를 설정할 수 있습니다.',400);
      const fee=body.fee_won===null?null:Number(body.fee_won);
      if(fee!==null&&(!Number.isSafeInteger(fee)||fee<0||fee>1000000))
        err('참가비는 0원(무료)부터 100만원까지 입력해 주세요.',400);
      // Never rewrite the fee of a confirmed or previously paid application.
      if(payment?.fee_won!==fee){
        const {data:existing,error:existingError}=await service.from('event_applications')
          .select('id,status,payment_status').eq('event_id',eventId);
        if(existingError)throw existingError;
        if((existing||[]).some((a:any)=>a.status==='CONFIRMED'||['PAID','REFUND_PENDING','REFUNDED'].includes(a.payment_status)))
          err('확정 또는 입금 내역이 있는 일정의 참가비는 변경할 수 없습니다.',409);
      }
      const instructions=String(body.payment_instructions||'').trim();
      const refundInstructions=String(body.refund_instructions||'').trim();
      if(instructions.length>500||refundInstructions.length>500)err('안내 문구는 500자 이내로 작성해 주세요.',400);
      const dueRaw=body.payment_due_at==null||body.payment_due_at===''?null:String(body.payment_due_at);
      if(dueRaw&&(Number.isNaN(Date.parse(dueRaw))||dueRaw.length>40))err('올바른 입금 기한을 입력해 주세요.',400);
      const due=dueRaw?new Date(dueRaw).toISOString():null;
      const {data:saved,error:se}=await service.from('event_payment_settings').upsert({
        event_id:eventId,fee_won:fee,payment_instructions:instructions||null,
        refund_instructions:refundInstructions||null,payment_due_at:due,updated_at:new Date().toISOString()
      },{onConflict:'event_id'}).select('fee_won,payment_instructions,refund_instructions,payment_due_at').single();
      if(se)throw se;
      return reply(origin,{ok:true,payment:saved});
    }
    if(['apply','cancel'].includes(body.action)){
      if(!member?.is_active)err('활동 회원만 신청할 수 있습니다.',403);
      const {data,error}=await service.rpc('vom_event_application_change',{p_event_id:eventId,p_member_id:member.id,p_action:body.action});
      if(error)return reply(origin,{error:errorText(error)},409);
      return reply(origin,{ok:true,...data});
    }
    if(['mark_paid','mark_unpaid','refund_complete'].includes(body.action)){
      if(body.action!=='refund_complete'&&(payment?.fee_won==null||payment.fee_won<=0))err('유료 일정의 참가비 설정을 먼저 완료해 주세요.',409);
      const appId=numberId(body.application_id);
      const paid=body.action==='mark_paid',unpaid=body.action==='mark_unpaid';
      const patch=paid?{payment_status:'PAID',paid_at:new Date().toISOString(),paid_recorded_by:userId,updated_at:new Date().toISOString()}
        :unpaid?{payment_status:'UNPAID',paid_at:null,paid_recorded_by:null,updated_at:new Date().toISOString()}
        :{payment_status:'REFUNDED',refunded_at:new Date().toISOString(),refunded_recorded_by:userId,updated_at:new Date().toISOString()};
      let change=service.from('event_applications').update(patch).eq('id',appId).eq('event_id',eventId);
      change=paid?change.eq('status','APPLIED').eq('payment_status','UNPAID')
        :unpaid?change.eq('status','APPLIED').eq('payment_status','PAID')
        :change.eq('status','CANCELLED').eq('payment_status','REFUND_PENDING');
      const {data:changed,error:changeError}=await change.select('id,status,payment_status').maybeSingle();
      if(changeError)throw changeError;
      if(!changed)err('상태가 변경돼 처리하지 못했습니다. 목록을 새로 확인해 주세요.',409);
      return reply(origin,{ok:true,application:changed});
    }
    if(body.action==='confirm'||body.action==='unconfirm'){
      const applicationId=numberId(body.application_id);
      const desired=body.action==='confirm'?'CONFIRMED':'APPLIED';
      if(desired==='CONFIRMED'&&payment?.fee_won==null)
        err('참가비를 먼저 설정해 주세요. 무료 행사도 0원으로 설정해야 합니다.',409);
      let update=service.from('event_applications').update({status:desired,confirmed_at:desired==='CONFIRMED'?new Date().toISOString():null,updated_at:new Date().toISOString()}).eq('id',applicationId).eq('event_id',eventId);
      update=desired==='CONFIRMED'
        ?update.eq('status','APPLIED').eq('payment_status',payment?.fee_won>0?'PAID':'UNPAID')
        :update.eq('status','CONFIRMED');
      const {data,error}=await update.select('id,status,payment_status').maybeSingle();
      if(error)throw error;
      if(!data)err('신청 상태 또는 입금 확인 여부를 점검해 주세요.',409);
      return reply(origin,{ok:true,application:data});
    }
    const {data:applications,error:le}=await service.from('event_applications').select('id,member_id,status,applied_at,payment_status,paid_at,refunded_at').eq('event_id',eventId).order('applied_at',{ascending:true});
    if(le)throw le;
    const rows=applications||[];
    const count=rows.filter((x:any)=>x.status!=='CANCELLED').length;
    const mine=member?rows.find((x:any)=>Number(x.member_id)===Number(member.id)):null;
    const result:any={ok:true,event,payment:payment||{fee_won:null,payment_instructions:null,refund_instructions:null,payment_due_at:null},count,mine:mine?{id:mine.id,status:mine.status,payment_status:mine.payment_status}:null,is_admin:isAdmin,
      now:new Date().toISOString()};
    if(isAdmin){
      const ids=rows.map((x:any)=>x.member_id);
      const {data:people,error:pe}=ids.length?await service.from('members').select('id,name').in('id',ids):{data:[],error:null};
      if(pe)throw pe;
      const names=new Map((people||[]).map((x:any)=>[String(x.id),x.name]));
      result.applications=rows.map((x:any)=>({id:x.id,name:names.get(String(x.member_id))||'회원',status:x.status,payment_status:x.payment_status,applied_at:x.applied_at,paid_at:x.paid_at,refunded_at:x.refunded_at}));
    }
    return reply(origin,result);
  }catch(e:any){const status=Number(e?.status)||500;if(status>=500)console.error('event_application_error',e?.name||'error');return reply(origin,{error:status>=500?'신청 정보를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.':e.message},status);}
}
if(import.meta.main)Deno.serve(req=>handle(req,createClient(URL_,KEY_,{auth:{persistSession:false,autoRefreshToken:false}})));
