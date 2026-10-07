import webpush from "npm:web-push@3.6.7";
import { DEFAULT_ORIGIN } from "./ot-core.ts";

// Registration is committed before this runs. Failed notification attempts never undo an upload.
export async function notifyOT(service: any, reviewId: number) {
  const now = new Date().toISOString();
  const leaseBefore = new Date(Date.now() - 120_000).toISOString();
  const { data: review, error: claimError } = await service.from("ot_reviews")
    .update({ notification_claimed_at: now })
    .eq("id", reviewId).is("operator_notified_at", null)
    .lte("notification_next_attempt_at", now)
    .or(`notification_claimed_at.is.null,notification_claimed_at.lt.${leaseBefore}`)
    .select("id,candidate_name,somoim_nickname,notification_attempts").maybeSingle();
  if (claimError || !review) return { sent: 0, pending: true };

  let sent = 0;
  try {
    const [{ data: config, error: ce }, { data: subscriptions, error: se }] = await Promise.all([
      service.from("vom_push_config").select("vapid_public_key,vapid_private_key,subject").eq("id", 1).maybeSingle(),
      service.from("vom_push_subscriptions").select("id,endpoint,p256dh,auth,vom_push_invites!inner(is_active)")
        .eq("is_active", true).eq("vom_push_invites.is_active", true),
    ]);
    if (ce || se) throw new Error("push_config_failed");
    if (config && subscriptions?.length) {
      webpush.setVapidDetails(config.subject, config.vapid_public_key, config.vapid_private_key);
      const payload = JSON.stringify({
        title: "새 OT 영상이 등록됐어요",
        body: `${review.candidate_name}님 · ${review.somoim_nickname}\n운영진 페이지에서 확인해 주세요.`,
        url: `${DEFAULT_ORIGIN}/ot-admin/?id=${review.id}`,
        tag: `vom-ot-review-${review.id}`,
      });
      await Promise.all(subscriptions.map(async (subscription: any) => {
        try {
          await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, { TTL: 7200, timeout: 10_000 });
          sent++;
        } catch (error: any) {
          if (error?.statusCode === 404 || error?.statusCode === 410) await service.from("vom_push_subscriptions").update({ is_active: false, updated_at: now }).eq("id", subscription.id);
          console.error("OT push delivery failed", Number(error?.statusCode) || 0);
        }
      }));
    }
  } catch {
    console.error("OT notification attempt failed");
  } finally {
    const { error } = await service.from("ot_reviews").update({
      operator_notified_at: sent ? new Date().toISOString() : null,
      notification_attempts: Number(review.notification_attempts || 0) + 1,
      notification_next_attempt_at: new Date(Date.now() + 300_000).toISOString(),
      notification_claimed_at: null,
    }).eq("id", reviewId).eq("notification_claimed_at", now);
    if (error) console.error("OT notification state update failed");
  }
  return { sent, pending: !sent };
}

export async function notifyPendingOT(service: any) {
  const { data, error } = await service.from("ot_reviews").select("id")
    .is("operator_notified_at", null).lte("notification_next_attempt_at", new Date().toISOString())
    .order("created_at", { ascending: true }).limit(3);
  if (error) return { attempted: 0 };
  await Promise.all((data || []).map((review: any) => notifyOT(service, Number(review.id))));
  return { attempted: data?.length || 0 };
}
