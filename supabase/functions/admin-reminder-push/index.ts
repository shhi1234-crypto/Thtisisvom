import { processSignupReservations } from "../_shared/signup-reservations.ts";
import { notifyPendingOT, notifyPendingApprovals } from "../_shared/ot-push.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import webpush from "npm:web-push@3.6.7";

const allowedOrigin="https://thisisvom.vercel.app";
const headers={
  "Access-Control-Allow-Origin":allowedOrigin,
  "Access-Control-Allow-Headers":"authorization, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS",
  "Content-Type":"application/json; charset=utf-8",
  "Vary":"Origin"
};

function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers});}
function seoulParts(value=new Date()){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(value);
  const get=(type:string)=>parts.find(part=>part.type===type)?.value||"";
  return {date:`${get("year")}-${get("month")}-${get("day")}`,hour:Number(get("hour")),minute:Number(get("minute"))};
}
function isDueTime(notifyTime:string|undefined,now:{hour:number;minute:number}){
  const [hour,minute]=String(notifyTime||"10:00").slice(0,5).split(":").map(Number);
  const diff=(now.hour*60+now.minute)-(hour*60+minute);
  return diff>=0&&diff<5;
}
function daysInMonth(date:string){
  const [year,month]=date.split("-").map(Number);
  return new Date(Date.UTC(year,month,0)).getUTCDate();
}
function dateWithOffset(date:string,offset:number){
  const value=new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate()+offset);
  return value.toISOString().slice(0,10);
}
function taskReminderTiming(offset:number){
  if(offset===-7)return "마감 7일 전입니다.";
  if(offset===-1)return "마감 전날입니다.";
  return "오늘 마감일입니다.";
}
function isScheduledFor(row:any,now:{date:string;hour:number;minute:number}){
  if(!isDueTime(row.notify_time,now))return false;
  const day=Number(now.date.slice(-2));
  const lastDay=daysInMonth(now.date);
  if(row.trigger_type==="month_end")return day===lastDay;
  if(row.trigger_type==="month_end_minus_one")return day===lastDay-1;
  if(row.trigger_type==="monthly_day")return day===Number(row.monthly_day);
  if(row.trigger_type==="next_month_schedule_check")return day===20;
  if(row.trigger_type==="once"){
    if(!row.run_at)return false;
    const target=seoulParts(new Date(row.run_at));
    return target.date===now.date&&isDueTime(`${String(target.hour).padStart(2,"0")}:${String(target.minute).padStart(2,"0")}`,now);
  }
  return false;
}

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
  if(req.method!=="POST")return json({error:"not_allowed"},403);

  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
  const body=await req.json().catch(()=>null);
  const action=body?.action;
  const {data:config,error:configError}=await admin.from("vom_push_config").select("vapid_public_key,vapid_private_key,subject,cron_secret").eq("id",1).maybeSingle();
  if(configError||!config)return json({error:"push_not_configured"},503);

  if(action==="event_created"){
    if(req.headers.get("origin")!==allowedOrigin)return json({error:"not_allowed"},403);
    const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
    if(!token)return json({error:"auth_required"},401);
    const {data:userData,error:userError}=await admin.auth.getUser(token);
    const userId=userData?.user?.id;
    if(userError||!userId)return json({error:"auth_required"},401);
    const {data:isAdmin}=await admin.from("admins").select("user_id").eq("user_id",userId).maybeSingle();
    if(!isAdmin)return json({error:"admin_required"},403);

    const eventTitle=String(body?.eventTitle||"새 일정").slice(0,100);
    const eventType=String(body?.eventType||"일정").slice(0,30);
    const hostName=String(body?.hostName||"미정").slice(0,40);
    const {data:setting}=await admin.from("operation_reminders").select("id,title,message").eq("trigger_type","event_created").eq("is_active",true).limit(1).maybeSingle();
    if(!setting)return json({ok:true,skipped:true});

    const title=`새 ${eventType} 일정 등록`;
    const message=`${eventTitle}\n주최자는 ${hostName}님입니다.\n${setting.message}`;
    const sent=await sendToAll(admin,config,{title,body:message,tag:"vom-event-created"});
    return json({ok:true,sent});
  }

  if(action!=="due_reminders"||!config.cron_secret||req.headers.get("x-vom-cron-secret")!==config.cron_secret)return json({error:"not_allowed"},403);
  try { await processSignupReservations(admin); } catch { console.error("Signup reservation processing deferred"); }

  const now=seoulParts();
  const {data:settings,error:settingsError}=await admin.from("operation_reminders").select("id,title,message,trigger_type,run_at,monthly_day,notify_time").eq("is_active",true).in("trigger_type",["month_end_minus_one","month_end","once","monthly_day","next_month_schedule_check"]);
  if(settingsError)return json({error:"settings_unavailable"},503);

  let sent=0,matched=0;
  for(const setting of settings||[]){
    if(!isScheduledFor(setting,now))continue;
    if(setting.trigger_type==="next_month_schedule_check"){
      const [year,month]=now.date.split("-").map(Number);
      const start=new Date(Date.UTC(year,month,1)).toISOString().slice(0,10);
      const end=new Date(Date.UTC(year,month+1,1)).toISOString().slice(0,10);
      const {count,error:countError}=await admin.from("events").select("id",{count:"exact",head:true}).gte("event_date",start).lt("event_date",end);
      if(countError||Number(count||0)>0)continue;
    }
    matched++;
    const occurrenceKey=`${setting.trigger_type}:${now.date}:${setting.id}`;
    const {error:deliveryError}=await admin.from("operation_reminder_deliveries").insert({reminder_id:setting.id,occurrence_key:occurrenceKey});
    if(deliveryError){
      if(deliveryError.code==="23505")continue;
      continue;
    }
    sent+=await sendToAll(admin,config,{title:setting.title,body:setting.message,tag:`vom-reminder-${setting.id}`});
    if(setting.trigger_type==="once")await admin.from("operation_reminders").update({is_active:false,updated_at:new Date().toISOString()}).eq("id",setting.id);
  }
  const {data:taskRows,error:taskError}=await admin
    .from("event_operation_tasks")
    .select("id,event_id,title,due_date,reminder_offsets,reminder_time")
    .eq("is_done",false)
    .not("due_date","is",null);

  if(!taskError&&(taskRows||[]).length){
    const eventIds=[...new Set((taskRows||[]).map((task:any)=>Number(task.event_id)).filter(Boolean))];
    const {data:eventRows}=await admin
      .from("events")
      .select("id,title,event_type,host_member_id")
      .in("id",eventIds);
    const eventMap=new Map((eventRows||[]).map((event:any)=>[Number(event.id),event]));
    const hostIds=[...new Set((eventRows||[]).map((event:any)=>Number(event.host_member_id)).filter(Boolean))];
    const {data:hostRows}=hostIds.length
      ? await admin.from("members").select("id,name").in("id",hostIds)
      : {data:[]};
    const hostMap=new Map((hostRows||[]).map((member:any)=>[Number(member.id),String(member.name||"미정")]));

    for(const task of taskRows||[]){
      const event=eventMap.get(Number(task.event_id));
      if(!event||!["BUSKING","VOM LIVE"].includes(event.event_type))continue;

      const offsets=Array.isArray(task.reminder_offsets)
        ? task.reminder_offsets.map(Number).filter((offset:number)=>[-7,-1,0].includes(offset))
        : [0];

      for(const offset of offsets){
        if(dateWithOffset(String(task.due_date),offset)!==now.date||!isDueTime(task.reminder_time,now))continue;
        matched++;
        const occurrenceKey=`task:${task.id}:${now.date}:${offset}`;
        const {error:deliveryError}=await admin
          .from("event_operation_task_reminder_deliveries")
          .insert({task_id:task.id,occurrence_key:occurrenceKey});
        if(deliveryError)continue;

        const typeLabel=event.event_type==="BUSKING"?"버스킹":"VOM LIVE";
        const hostName=hostMap.get(Number(event.host_member_id))||"미정";
        sent+=await sendToAll(admin,config,{
          title:`${typeLabel} 운영 리마인더`,
          body:`${event.title||"일정"}\n${task.title} · ${taskReminderTiming(offset)}\n주최자는 ${hostName}님입니다.`,
          tag:`vom-event-task-${task.id}-${offset}`
        });
      }
    }
  }

  const otNotifications=await notifyPendingOT(admin).catch(()=>({attempted:0}));
  await notifyPendingApprovals(admin).catch(()=>({attempted:0}));
  return json({ok:true,matched,sent,date:now.date,ot_notifications:otNotifications});
});

async function sendToAll(admin:any,config:any,payload:{title:string;body:string;tag:string}){
  const {data:subs,error}=await admin.from("vom_push_subscriptions").select("id,endpoint,p256dh,auth").eq("is_active",true);
  if(error)return 0;
  webpush.setVapidDetails(config.subject,config.vapid_public_key,config.vapid_private_key);
  let sent=0;
  for(const sub of subs||[]){
    try{
      await webpush.sendNotification({endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}},JSON.stringify({
        title:payload.title,body:payload.body,url:"https://thisisvom.vercel.app/admin-settings/",tag:payload.tag
      }),{TTL:3600});
      sent++;
    }catch(error:any){
      const status=Number(error?.statusCode||0);
      if(status===404||status===410)await admin.from("vom_push_subscriptions").update({is_active:false}).eq("id",sub.id);
    }
  }
  return sent;
}
