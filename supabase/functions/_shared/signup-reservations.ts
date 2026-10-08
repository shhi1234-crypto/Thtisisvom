import { isRegistrationOpen, mediaLink } from './ot-core.ts';
import { notifyOT } from './ot-push.ts';

export function nextRegistrationAt(now = new Date()) {
  const korea = new Date(now.getTime() + 9 * 3600000);
  return new Date(Date.UTC(korea.getUTCFullYear(), korea.getUTCMonth(), korea.getUTCDate() + 1)).toISOString();
}

// The authenticated cron processes stored private media; no browser or password is needed.
export async function processSignupReservations(service: any, now = () => new Date()) {
  if (!isRegistrationOpen(now())) return 0;
  const stamp = now().toISOString(), lease = new Date(now().getTime() - 120000).toISOString();
  const { data: rows, error } = await service.from('ot_signup_reservations').select('invite_id,claim_id,media_path,file_name,media_source,media_url')
    .in('status', ['WAITING', 'PROCESSING']).lte('scheduled_at', stamp).lte('next_attempt_at', stamp)
    .or(`claimed_at.is.null,claimed_at.lt.${lease}`).order('scheduled_at').limit(10);
  if (error) throw new Error('signup_reservations_lookup_failed');
  let completed = 0;
  for (const row of rows || []) {
    const { data: claimed, error: claimError } = await service.from('ot_signup_reservations').update({ status: 'PROCESSING', claimed_at: stamp })
      .eq('invite_id', row.invite_id).in('status', ['WAITING', 'PROCESSING']).or(`claimed_at.is.null,claimed_at.lt.${lease}`).select('invite_id').maybeSingle();
    if (claimError || !claimed) continue;
    try {
      const { data: invite, error: inviteError } = await service.from('ot_room_invites').select('review_id,revoked_at,expires_at').eq('id', row.invite_id).maybeSingle();
      if (inviteError) throw new Error('reservation_invite_lookup_failed');
      if (!invite || invite.revoked_at || new Date(invite.expires_at) <= now()) {
        await service.from('ot_signup_reservations').update({ status: 'CANCELLED', claimed_at: null }).eq('invite_id', row.invite_id);
        continue;
      }
      let reviewId = Number(invite.review_id);
      if (!reviewId) {
        const { error: renewError } = await service.from('ot_room_invites').update({ upload_claimed_at: now().toISOString() })
          .eq('id', row.invite_id).eq('upload_claim_id', row.claim_id).is('review_id', null);
        if (renewError) throw new Error('reservation_claim_refresh_failed');
        const linked=row.media_source==='LINK';
        const { data, error: finalizeError } = await service.rpc(linked?'vom_ot_finalize_link':'vom_ot_finalize_upload', linked?{
          p_invite_id:row.invite_id,p_claim_id:row.claim_id,p_media_url:mediaLink(row.media_url),
        }:{p_invite_id: row.invite_id, p_claim_id: row.claim_id, p_candidate_name: '', p_somoim_nickname: '', p_file_path: row.media_path, p_file_name: row.file_name});
        if (finalizeError) throw new Error('reservation_finalize_failed');
        reviewId = Number(Array.isArray(data) ? data[0]?.id : data?.id);
        if (!reviewId) throw new Error('reservation_review_missing');
      }
      const { error: doneError } = await service.from('ot_signup_reservations').update({ status: 'COMPLETE', completed_at: now().toISOString(), claimed_at: null })
        .eq('invite_id', row.invite_id);
      if (doneError) throw new Error('reservation_complete_failed');
      completed++;
      try { await notifyOT(service, reviewId); } catch { console.error('Reserved OT notification queued'); }
    } catch {
      await service.from('ot_signup_reservations').update({ status: 'WAITING', claimed_at: null, next_attempt_at: new Date(now().getTime() + 300000).toISOString() }).eq('invite_id', row.invite_id);
      console.error('Signup reservation retry queued');
    }
  }
  return completed;
}
