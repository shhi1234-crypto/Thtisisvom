import webpush from "npm:web-push@3.6.7";
import { DEFAULT_ORIGIN } from "./ot-core.ts";

// Registration is committed before this runs. Failed notification attempts never undo an upload.
export async function notifyOT(service: any, reviewId: number, send=webpush.sendNotification.bind(webpush)) {
  const now = new Date().toISOString();
  const leaseBefore = new Date(Date.now() - 120_000).toISOString();
  const { data: review, error: claimError } = await service.from("ot_reviews")
    .update({ notification_claimed_at: now })
    .eq("id", reviewId).is("operator_notified_at", null)
    .lte("notification_next_attempt_at", now)
    .or(`notification_claimed_at.is.null,notification_claimed_at.lt.${leaseBefore}`)
    .select("id,candidate_name,eligible_operator_ids,notification_attempts").maybeSingle();
  if (claimError || !review) return { sent: 0, pending: true };

  let sent = 0, complete = false;
  try {
    const [{ data: config, error: ce }, { data: subscriptions, error: se }, {data:operators,error:oe}, {data:deliveries,error:de}] = await Promise.all([
      service.from("vom_push_config").select("vapid_public_key,vapid_private_key,subject").eq("id", 1).maybeSingle(),
      service.from("vom_push_subscriptions").select("id,endpoint,p256dh,auth,vom_push_invites!inner(is_active,recipient_name)")
        .eq("is_active", true).eq("vom_push_invites.is_active", true),
      service.from('members').select('id,name').eq('role','운영진').eq('is_active',true).in('id',review.eligible_operator_ids||[]),
      service.from('ot_operator_push_deliveries').select('subscription_id').eq('review_id',reviewId),
    ]);
    if (ce || se || oe || de) throw new Error("push_config_failed");
    const names=new Set((operators||[]).map((op:any)=>op.name));
    const targets=(subscriptions||[]).filter((sub:any)=>names.has(sub.vom_push_invites?.recipient_name));
    const delivered=new Set((deliveries||[]).map((row:any)=>String(row.subscription_id)));
    if (config && targets.length) {
      webpush.setVapidDetails(config.subject, config.vapid_public_key, config.vapid_private_key);
      const payload = JSON.stringify({
        title: "새 회원가입 신청이 접수됐어요",
        body: `${review.candidate_name}님이 신청했습니다.\n3시간 이내에 확인해 주세요.`,
        url: `${DEFAULT_ORIGIN}/ot-admin/?id=${review.id}`,
        tag: `vom-ot-review-${review.id}`,
      });
      let failed=0;
      await Promise.all(targets.map(async (subscription: any) => {
        if(delivered.has(String(subscription.id)))return;
        try {
          await send({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, { TTL: 10800, timeout: 10_000 });
          const {error}=await service.from('ot_operator_push_deliveries').upsert({review_id:reviewId,subscription_id:subscription.id,sent_at:new Date().toISOString()},{onConflict:'review_id,subscription_id'});
          if(error)throw new Error('push_delivery_record_failed');
          sent++;
        } catch (error: any) {
          if (error?.statusCode === 404 || error?.statusCode === 410) {
            const {error:disabled}=await service.from("vom_push_subscriptions").update({ is_active: false, updated_at: now }).eq("id", subscription.id);
            if(disabled)failed++;
          } else failed++;
          console.error("OT push delivery failed", Number(error?.statusCode) || 0);
        }
      }));
      complete=failed===0&&(sent>0||targets.some((sub:any)=>delivered.has(String(sub.id))));
    }
  } catch {
    console.error("OT notification attempt failed");
  } finally {
    const { error } = await service.from("ot_reviews").update({
      operator_notified_at: complete ? new Date().toISOString() : null,
      notification_attempts: Number(review.notification_attempts || 0) + 1,
      notification_next_attempt_at: new Date(Date.now() + 300_000).toISOString(),
      notification_claimed_at: null,
    }).eq("id", reviewId).eq("notification_claimed_at", now);
    if (error) console.error("OT notification state update failed");
  }
  return { sent, pending: !complete };
}

export async function notifyPendingOT(service: any) {
  const { data, error } = await service.from("ot_reviews").select("id")
    .is("operator_notified_at", null).lte("notification_next_attempt_at", new Date().toISOString())
    .order("created_at", { ascending: true }).limit(3);
  if (error) return { attempted: 0 };
  await Promise.all((data || []).map((review: any) => notifyOT(service, Number(review.id))));
  return { attempted: data?.length || 0 };
}

// Shares the existing VAPID configuration, but applicant endpoints are a private queue.
export async function notifyApproval(service: any, reviewId: number, send=webpush.sendNotification.bind(webpush)) {
  const now=new Date().toISOString(),before=new Date(Date.now()-120000).toISOString();
  const {data:review,error:ce}=await service.from('ot_reviews').update({approval_notification_claimed_at:now})
    .eq('id',reviewId).eq('status','APPROVED').is('approval_notified_at',null)
    .lte('approval_notification_next_attempt_at',now).or(`approval_notification_claimed_at.is.null,approval_notification_claimed_at.lt.${before}`)
    .select('id,approval_notification_attempts').maybeSingle();
  if (ce || !review) return {sent:0,pending:true};
  let sent=0;
  try {
    const {data:invite,error:ie}=await service.from('ot_room_invites').select('id,notification_push_enabled').eq('review_id',reviewId).maybeSingle();
    if (ie) throw new Error('approval_invite_lookup_failed');
    if (!invite?.notification_push_enabled) return {sent:0,pending:false};
    const [{data:config,error:pe},{data:subscription,error:se}]=await Promise.all([
      service.from('vom_push_config').select('vapid_public_key,vapid_private_key,subject').eq('id',1).maybeSingle(),
      service.from('ot_applicant_push_subscriptions').select('id,endpoint,p256dh,auth').eq('invite_id',invite.id).eq('is_active',true).maybeSingle()
    ]);
    if (pe || se) throw new Error('approval_push_lookup_failed');
    if (config && subscription) {
      webpush.setVapidDetails(config.subject,config.vapid_public_key,config.vapid_private_key);
      try {
        await send({endpoint:subscription.endpoint,keys:{p256dh:subscription.p256dh,auth:subscription.auth}},JSON.stringify({title:'VOM 가입이 승인됐어요',body:'설정한 개인 계정으로 로그인하고 멤버스와 캘린더를 이용해 주세요.',url:DEFAULT_ORIGIN+'/me/',tag:'vom-approval-'+reviewId}),{TTL:86400,timeout:10000});
        sent=1;
      } catch(error:any) {
        if (error?.statusCode===404 || error?.statusCode===410) {
          await service.from('ot_applicant_push_subscriptions').update({is_active:false,updated_at:now}).eq('id',subscription.id);
          await service.from('ot_room_invites').update({notification_push_enabled:false}).eq('id',invite.id);
        }
        console.error('Approval push delivery failed',Number(error?.statusCode)||0);
      }
    }
  } catch { console.error('Approval notification attempt failed'); }
  finally {
    const {error}=await service.from('ot_reviews').update({approval_notified_at:sent?new Date().toISOString():null,approval_notification_attempts:Number(review.approval_notification_attempts||0)+1,approval_notification_next_attempt_at:new Date(Date.now()+300000).toISOString(),approval_notification_claimed_at:null}).eq('id',reviewId).eq('approval_notification_claimed_at',now);
    if (error) console.error('Approval notification state update failed');
  }
  return {sent,pending:!sent};
}

export async function notifyPendingApprovals(service:any) {
  const {data,error}=await service.from('ot_reviews').select('id,ot_room_invites!inner(notification_push_enabled)')
    .eq('status','APPROVED').eq('ot_room_invites.notification_push_enabled',true).is('approval_notified_at',null)
    .lte('approval_notification_next_attempt_at',new Date().toISOString()).order('created_at',{ascending:true}).limit(3);
  if (error) return {attempted:0};
  await Promise.all((data||[]).map((review:any)=>notifyApproval(service,Number(review.id))));
  return {attempted:data?.length||0};
}
