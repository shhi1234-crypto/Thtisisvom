import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { ApiError, DEFAULT_ORIGIN, checkRequest, failure, headers, json } from "../_shared/ot-core.ts";
import { memberContext, signedIn } from "../_shared/member-access.ts";

Deno.serve(async(req:Request)=>{
  let origin=DEFAULT_ORIGIN;
  try {
    origin=checkRequest(req);
    if(req.method==="OPTIONS")return new Response(null,{status:204,headers:headers(origin)});
    const service=createClient(Deno.env.get("SUPABASE_URL")||"",Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",{auth:{persistSession:false,autoRefreshToken:false}});
    const user=await signedIn(req,service),context=await memberContext(service,user.id);
    if(context.state!=="APPROVED")throw new ApiError(403,"가입 승인 후 스케줄을 확인할 수 있습니다.");
    const {data,error}=await service.from("events").select("id,title,event_type,event_date,start_time,end_time,location,image_url").order("event_date").order("start_time");
    if(error)throw new Error("schedule_lookup_failed");
    return json(origin,{ok:true,events:data||[]});
  }catch(error){return failure(origin,error);}
});
