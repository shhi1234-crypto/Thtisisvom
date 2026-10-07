import {createClient} from 'npm:@supabase/supabase-js@2.117.2';
import {ApiError,DEFAULT_ORIGIN,checkRequest,failure,headers,json} from '../_shared/ot-core.ts';
import {memberContext,signedIn} from '../_shared/member-access.ts';

export function birthdayParts(value:unknown){
  const match=String(value||'').match(/^\d{4}-(\d{2})-(\d{2})$/);if(!match)return null;
  const month=Number(match[1]),day=Number(match[2]),check=new Date(Date.UTC(2000,month-1,day));
  return check.getUTCMonth()===month-1&&check.getUTCDate()===day?{month,day}:null;
}
export function nextBirthday(rows:any[],now=new Date()){
  const korea=new Date(now.getTime()+9*3600000),year=korea.getUTCFullYear();
  const today=Date.UTC(year,korea.getUTCMonth(),korea.getUTCDate());let next:number|null=null;
  for(const row of rows){const birth=birthdayParts(row.birth_date);if(!birth)continue;
    for(let y=year;y<=year+8;y++){const date=new Date(Date.UTC(y,birth.month-1,birth.day));if(date.getUTCMonth()!==birth.month-1||date.getUTCDate()!==birth.day)continue;const stamp=date.getTime();if(stamp<today)continue;if(next===null||stamp<next)next=stamp;break;}
  }
  return next===null?null:new Date(next).toISOString().slice(0,10);
}
export async function handle(req:Request,service:any,now=()=>new Date()){
  let origin=DEFAULT_ORIGIN;
  try{
    origin=checkRequest(req);if(req.method==='OPTIONS')return new Response(null,{status:204,headers:headers(origin)});
    let body;try{body=await req.json();}catch{throw new ApiError(400,'요청 내용을 확인해 주세요.');}
    if(!['summary','people'].includes(body.action))throw new ApiError(400,'지원하지 않는 요청입니다.');
    const people=body.action==='people';
    if(people){const user=await signedIn(req,service);if((await memberContext(service,user.id)).state!=='APPROVED')throw new ApiError(403,'가입 승인 후 생일자를 확인할 수 있습니다.');}
    const {data,error}=await service.from('members').select(people?'id,name,birth_date':'birth_date').eq('is_active',true);
    if(error)throw new Error('birthday_lookup_failed');
    const next=nextBirthday(data||[],now());
    // Public response never contains a person, ID, birth year, count or raw list.
    if(!people)return json(origin,{ok:true,next_birthday:next});
    return json(origin,{ok:true,next_birthday:next,birthdays:(data||[]).flatMap((row:any)=>{const birthday=birthdayParts(row.birth_date);return birthday?[{id:row.id,name:row.name,...birthday}]:[];})});
  }catch(error){return failure(origin,error);}
}
if(import.meta.main)Deno.serve(req=>handle(req,createClient(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',{auth:{persistSession:false,autoRefreshToken:false}})));
