import { ApiError, REVIEW_MINUTES } from './ot-core.ts';

// Auth identity comes from the server's password check, never from request data.
// This response is deliberately limited to the caller's own review state and dates.
export async function applicationStatus(service: any, userId: string) {
  const {data:invite,error:ie}=await service.from('ot_room_invites')
    .select('id,review_id,revoked_at').eq('applicant_user_id',userId).maybeSingle();
  if(ie)throw new Error('application_status_lookup_failed');
  if(!invite)throw new ApiError(404,'이 계정의 회원가입 신청을 찾지 못했습니다. 운영진에게 확인해 주세요.');
  if(invite.review_id){
    const {data:review,error:re}=await service.from('ot_reviews')
      .select('status,created_at,completed_at').eq('id',invite.review_id).maybeSingle();
    if(re||!review)throw new Error('application_review_lookup_failed');
    return {state:review.status==='APPROVED'&&!review.completed_at?'APPROVED_WAITING':review.status,
      submitted_at:review.created_at,check_at:new Date(Date.parse(review.created_at)+REVIEW_MINUTES*60000).toISOString()};
  }
  if(invite.revoked_at)return {state:'CANCELLED'};
  const {data:reservation,error:qe}=await service.from('ot_signup_reservations')
    .select('status,scheduled_at').eq('invite_id',invite.id).maybeSingle();
  if(qe)throw new Error('application_reservation_lookup_failed');
  if(reservation&&['WAITING','PROCESSING'].includes(reservation.status))return {state:'SCHEDULED',
    scheduled_at:reservation.scheduled_at,check_at:new Date(Date.parse(reservation.scheduled_at)+REVIEW_MINUTES*60000).toISOString()};
  return {state:reservation?.status==='CANCELLED'?'CANCELLED':'PREPARING'};
}
