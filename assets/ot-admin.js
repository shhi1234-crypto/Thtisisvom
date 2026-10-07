(function(){
  'use strict';
  const db=supabase.createClient('https://aqfmhqultzpakfqwzulj.supabase.co','sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R');
  const message=document.getElementById('adminMessage');
  const dashboard=document.getElementById('adminDashboard');
  const login=document.getElementById('loginCard');
  const reviewList=document.getElementById('reviewList');
  let state=null,filter='IN_REVIEW',refreshing=false,actionBusy=false;
  const media=new Map(),photos=new Map();
  const focusId=Number(new URLSearchParams(location.search).get('id'));
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const when=value=>{if(!value)return '';const date=new Date(Date.parse(value)+9*60*60*1000);if(!Number.isFinite(date.getTime()))return '';return `${date.getUTCMonth()+1}/${date.getUTCDate()} ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')}`;};
  const decisionLabel={APPROVE:'승인',REJECT:'반려',HOLD:'보류'};
  const statusLabel={IN_REVIEW:'검토 대기',APPROVED:'승인',REJECTED:'반려'};
  function say(text,kind=''){message.textContent=text;message.className='ot-message'+(kind?' '+kind:'');}
  async function request(body,binary=false){
    const {data}=await db.auth.getSession();
    if(!data.session)throw Object.assign(new Error('운영진 로그인이 필요합니다.'),{status:401});
    const response=await fetch('https://aqfmhqultzpakfqwzulj.supabase.co/functions/v1/ot-review',{method:'POST',headers:{'Content-Type':'application/json',apikey:'sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R',Authorization:'Bearer '+data.session.access_token},body:JSON.stringify(body),cache:'no-store',referrerPolicy:'no-referrer'});
    if(binary&&response.ok)return response.blob();
    let result;try{result=await response.json()}catch(_){throw new Error('서버 응답을 확인하지 못했습니다.');}
    if(!response.ok)throw Object.assign(new Error(result.error||'요청을 처리하지 못했습니다.'),{status:response.status});
    return result;
  }
  function clearMedia(){media.forEach(value=>URL.revokeObjectURL(value.url));photos.forEach(value=>URL.revokeObjectURL(value));media.clear();photos.clear();}
  function operatorName(id){return state?.operators.find(op=>Number(op.id)===Number(id))?.name||'운영진';}
  function reviewHtml(review){
    const id=Number(review.id);const pending=review.status==='IN_REVIEW';
    const approved=(review.votes||[]).filter(v=>v.decision==='APPROVE').length;
    const rejected=(review.votes||[]).filter(v=>v.decision==='REJECT').length;
    const eligible=new Set((review.eligible_operator_ids||[]).map(Number));
    const canVote=pending&&(state.actor.isAdmin||eligible.has(Number(state.actor.memberId)));
    const voter=state.actor.isAdmin?'<select id="voter-'+id+'" aria-label="의견을 남기는 운영진"><option value="">운영진 선택</option>'+state.operators.filter(op=>eligible.has(Number(op.id))).map(op=>'<option value="'+Number(op.id)+'">'+esc(op.name)+'</option>').join('')+'</select>':'<span class="ot-note" style="margin:0">'+esc(state.actor.name)+'님의 의견</span>';
    const voteControls=canVote?voter+'<button class="ot-button approve" data-action="vote" data-id="'+id+'" data-decision="APPROVE">승인</button><button class="ot-button reject" data-action="vote" data-id="'+id+'" data-decision="REJECT">반려</button><button class="ot-button hold" data-action="vote" data-id="'+id+'" data-decision="HOLD">보류</button>':'';
    const votes=(review.votes||[]).map(v=>'<span>'+esc(operatorName(v.voter_member_id))+' · '+decisionLabel[v.decision]+'</span>').join('')||'<span>아직 등록된 의견이 없습니다.</span>';
    const completion=review.status==='APPROVED'&&!review.completed_at&&state.actor.isAdmin?'<div class="ot-completion"><p class="ot-note" style="margin:0">이전 수동 등록 건입니다. 기존 회원과 연결해 주세요. 신규 계정 신청 건은 과반 승인 시 자동 가입됩니다.</p><div class="ot-review-controls"><select id="member-'+id+'" aria-label="최종 가입 완료 회원"><option value="">가입 완료 회원 선택</option>'+state.members.map(m=>'<option value="'+Number(m.id)+'">'+esc(m.name)+(m.nickname?' · '+esc(m.nickname):'')+'</option>').join('')+'</select><button class="ot-button ot-primary" data-action="complete" data-id="'+id+'">최종 가입 연결</button></div></div>':'';
    const profile=review.profile;
    const details=profile?[['출생연도',profile.birth_year?profile.birth_year+'년생':profile.birth_date||'미입력'],['직업',profile.job||'미입력'],['버스킹 경험',profile.busking_experience!=null?profile.busking_experience+(profile.busking_experience_unit==='YEARS'?'년':'회'):'미입력'],['연락처',profile.phone||'미입력'],['활동 지역',profile.region||'미입력'],['성별',profile.gender||'미입력']].map(([label,value])=>'<div><dt>'+esc(label)+'</dt><dd>'+esc(value)+'</dd></div>').join(''):'';
    return '<article id="review-'+id+'" class="ot-card"><div class="ot-review-top"><div><h3>'+esc(review.candidate_name)+'</h3><p>소모임 · '+esc(review.somoim_nickname)+'</p></div><span class="ot-tag">'+(review.completed_at?'가입 완료':statusLabel[review.status])+'</span></div><div class="ot-review-meta"><span>등록 '+when(review.created_at)+'</span>'+(pending?'<span>검토 목표 '+when(review.due_at)+(Date.parse(review.due_at)<Date.now()?' · 목표 시간 경과':'')+'</span>':'')+'<span>승인 '+approved+' · 반려 '+rejected+' / 과반 '+Number(review.required_majority)+'명</span><span>'+(review.operator_notified_at?'알림 발송됨':'알림 대기')+'</span></div>'+(review.status==='APPROVED'?'<p class="ot-note">'+(review.approval_notified_at?'신청자 승인 알림 발송됨':profile?.approval_push_enabled?'신청자 승인 알림 재시도 대기':'승인 알림 미등록 · 소모임으로 가입 완료 안내 필요')+'</p>':'')+(details?'<dl class="ot-profile-details">'+details+'</dl>':'')+'<div class="ot-review-controls">'+(profile?.has_photo?'<button class="ot-button" data-action="photo" data-id="'+id+'">본인사진 보기</button>':'')+'<button class="ot-button" data-action="video" data-id="'+id+'">'+(review.media_kind==='AUDIO'?'라이브 음성 듣기':'라이브 영상 보기')+'</button>'+voteControls+'</div><div class="ot-photo-host" id="photo-'+id+'"></div><div class="ot-video-host" id="video-'+id+'"></div><div class="ot-votes">'+votes+'</div>'+completion+'</article>';

  }
  function render(){
    const reviews=state.reviews.filter(r=>filter==='ALL'||r.status===filter);
    document.getElementById('pendingCount').textContent=state.reviews.filter(r=>r.status==='IN_REVIEW').length+'건 대기';
    reviewList.innerHTML=reviews.length?reviews.map(reviewHtml).join(''):'<div class="ot-empty">'+(filter==='IN_REVIEW'?'검토 대기 중인 가입 신청이 없습니다.':'해당 상태의 가입 신청이 없습니다.')+'</div>';
    media.forEach((value,id)=>{const host=document.getElementById('video-'+id);if(host)attachVideo(host,value.url,id,value.type);});
    photos.forEach((url,id)=>{const host=document.getElementById('photo-'+id);if(host)attachPhoto(host,url,id);});
    document.getElementById('operatorAccessList').innerHTML=state.actor.isAdmin?state.operators.map(op=>'<div class="ot-invite-item"><div>'+esc(op.name)+'<small>'+(op.ot_access?'가입 관리 권한 있음':op.has_account?'관리자 계정 확인 필요':'개인 계정 연결 필요')+'</small></div><button type="button" class="ot-button'+(op.ot_access?' ot-danger':'')+'" data-action="operator_access" data-member="'+Number(op.id)+'" data-enabled="'+(!op.ot_access)+'" '+(!op.has_account?'disabled':'')+'>'+(op.ot_access?'권한 회수':'권한 부여')+'</button></div>').join(''):'';
  }
  function attachVideo(host,url,id,type){
    host.replaceChildren();const video=document.createElement(type?.startsWith('audio/')?'audio':'video');video.controls=true;video.preload='metadata';video.playsInline=true;video.setAttribute('controlsList','nodownload');video.src=url;
    const close=document.createElement('button');close.type='button';close.className='ot-button';close.textContent='재생 닫기';close.dataset.action='close_video';close.dataset.id=String(id);host.append(video,close);
  }
  function attachPhoto(host,url,id){host.replaceChildren();const image=document.createElement('img');image.src=url;image.className='ot-photo';image.alt='가입자가 등록한 본인사진';const close=document.createElement('button');close.type='button';close.className='ot-button';close.textContent='사진 닫기';close.dataset.action='close_photo';close.dataset.id=String(id);host.append(image,close);}
  function denied(error){
    if(error.status===401||error.status===403){clearMedia();state=null;dashboard.hidden=true;login.hidden=false;reviewList.replaceChildren();document.getElementById('refreshButton').hidden=true;}
    say(error.message,'error');
  }
  async function refresh(showMessage=true,background=false){
    if(refreshing||(background&&(media.size||photos.size||reviewList.contains(document.activeElement))))return;refreshing=true;
    try{state=await request({action:'list'});login.hidden=true;dashboard.hidden=false;document.getElementById('refreshButton').hidden=false;document.getElementById('operatorName').textContent=state.actor.name;render();document.getElementById('lastRefreshed').textContent=when(new Date().toISOString())+' 확인';if(showMessage)say('운영진 전용 목록입니다. 가입 신청 접수 후 익일 안내될 수 있습니다.');}
    catch(error){denied(error);}finally{refreshing=false;}
  }
  document.getElementById('adminLoginForm').addEventListener('submit',async event=>{
    event.preventDefault();const button=document.getElementById('adminLoginButton');button.disabled=true;
    try{const {error}=await db.auth.signInWithPassword({email:document.getElementById('adminEmail').value.trim(),password:document.getElementById('adminPassword').value});if(error)throw new Error('이메일과 비밀번호를 확인해 주세요.');document.getElementById('adminPassword').value='';await refresh();}catch(error){say(error.message,'error');}finally{button.disabled=false;}
  });
  document.getElementById('reviewFilters').addEventListener('click',event=>{const button=event.target.closest('[data-filter]');if(!button||!state)return;filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b===button));render();});
  dashboard.addEventListener('click',async event=>{
    const button=event.target.closest('[data-action]');if(!button||!state||actionBusy)return;
    const action=button.dataset.action,id=Number(button.dataset.id);
    if(action==='close_video'){const value=media.get(id);if(value)URL.revokeObjectURL(value.url);media.delete(id);document.getElementById('video-'+id)?.replaceChildren();return;}
    if(action==='close_photo'){const url=photos.get(id);if(url)URL.revokeObjectURL(url);photos.delete(id);document.getElementById('photo-'+id)?.replaceChildren();return;}
    actionBusy=true;button.disabled=true;
    try{
      if(action==='video'){if(!media.has(id)){const blob=await request({action:'video',review_id:id},true);media.set(id,{url:URL.createObjectURL(blob),type:blob.type});}attachVideo(document.getElementById('video-'+id),media.get(id).url,id,media.get(id).type);}
      if(action==='photo'){if(!photos.has(id)){const blob=await request({action:'photo',review_id:id},true);photos.set(id,URL.createObjectURL(blob));}attachPhoto(document.getElementById('photo-'+id),photos.get(id),id);}
      if(action==='vote'){const voter=state.actor.isAdmin?Number(document.getElementById('voter-'+id).value):state.actor.memberId;if(!voter)throw new Error('운영진을 선택해 주세요.');await request({action:'vote',review_id:id,voter_member_id:voter,decision:button.dataset.decision});await refresh(false);say('심사 의견을 저장했습니다.','success');}
      if(action==='revoke'){if(!confirm('이 등록 링크를 중지할까요? 신규 가입자는 이 링크로 라이브 파일을 등록할 수 없게 됩니다.'))return;await request({action:'revoke_invite',invite_id:button.dataset.invite});await refresh(false);say('등록 링크를 중지했습니다.','success');}
      if(action==='complete'){const memberId=Number(document.getElementById('member-'+id).value);if(!memberId)throw new Error('최종 가입 완료 회원을 선택해 주세요.');if(!confirm('선택한 회원이 이 신규 가입자와 같은 사람인지 확인했나요?'))return;await request({action:'complete',review_id:id,member_id:memberId});await refresh(false);say('최종 가입 완료 회원과 연결했습니다.','success');}
      if(action==='operator_access'){const enabled=button.dataset.enabled==='true';if(!confirm(enabled?'본인 운영진 계정임을 확인했나요? 이 계정에서 신규 가입자의 사진·라이브 파일을 검토할 수 있게 됩니다.':'이 운영진의 가입 관리 권한을 회수할까요?'))return;await request({action:'operator_access',member_id:Number(button.dataset.member),enabled});await refresh(false);say(enabled?'가입 관리 권한을 부여했습니다.':'가입 관리 권한을 회수했습니다.','success');}
    }catch(error){denied(error);}finally{actionBusy=false;if(button.isConnected)button.disabled=false;}
  });
  document.getElementById('refreshButton').addEventListener('click',()=>refresh());
  document.getElementById('retryNotificationButton').addEventListener('click',async event=>{event.target.disabled=true;try{await request({action:'retry_notifications'});await refresh(false);say('대기 중인 알림을 재시도했습니다.');}catch(error){denied(error);}finally{event.target.disabled=false;}});
  db.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){clearMedia();state=null;dashboard.hidden=true;login.hidden=false;reviewList.replaceChildren();document.getElementById('operatorName').textContent='';document.getElementById('newInviteUrl').value='';document.getElementById('newInviteOutput').hidden=true;document.getElementById('refreshButton').hidden=true;say('로그아웃됐습니다. 운영진 계정으로 다시 로그인해 주세요.');}});
  window.addEventListener('pagehide',clearMedia);
  refresh().then(()=>{if(focusId&&state){filter='ALL';document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter==='ALL'));render();document.getElementById('review-'+focusId)?.scrollIntoView({behavior:'smooth',block:'start'});}});
  setInterval(()=>{if(state&&!actionBusy&&!document.hidden)refresh(false,true);},30000);
})();
