(function(){
  'use strict';
  const db=supabase.createClient('https://aqfmhqultzpakfqwzulj.supabase.co','sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R');
  const message=document.getElementById('adminMessage');
  const dashboard=document.getElementById('adminDashboard');
  const login=document.getElementById('loginCard');
  const reviewList=document.getElementById('reviewList');
  let state=null,filter='IN_REVIEW',refreshing=false,actionBusy=false;
  const media=new Map();
  const focusId=Number(new URLSearchParams(location.search).get('id'));
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const when=value=>value?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value)):'';
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
  function clearMedia(){media.forEach(value=>URL.revokeObjectURL(value.url));media.clear();}
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
    const completion=review.status==='APPROVED'&&!review.completed_at&&state.actor.isAdmin?'<div class="ot-completion"><p class="ot-note" style="margin:0">최종 가입을 안내하고 MEMBERS에 등록한 회원을 연결해 주세요. 영상 승인만으로 가입이 자동 완료되지는 않습니다.</p><div class="ot-review-controls"><select id="member-'+id+'" aria-label="최종 가입 완료 회원"><option value="">가입 완료 회원 선택</option>'+state.members.map(m=>'<option value="'+Number(m.id)+'">'+esc(m.name)+(m.nickname?' · '+esc(m.nickname):'')+'</option>').join('')+'</select><button class="ot-button ot-primary" data-action="complete" data-id="'+id+'">최종 가입 연결</button></div></div>':'';
    return '<article id="review-'+id+'" class="ot-card"><div class="ot-review-top"><div><h3>'+esc(review.candidate_name)+'</h3><p>소모임 · '+esc(review.somoim_nickname)+'</p></div><span class="ot-tag">'+(review.completed_at?'가입 완료':statusLabel[review.status])+'</span></div><div class="ot-review-meta"><span>등록 '+when(review.created_at)+'</span>'+(pending?'<span>검토 목표 '+when(review.due_at)+(Date.parse(review.due_at)<Date.now()?' · 목표 시간 경과':'')+'</span>':'')+'<span>승인 '+approved+' · 반려 '+rejected+' / 과반 '+Number(review.required_majority)+'명</span><span>'+(review.operator_notified_at?'알림 발송됨':'알림 대기')+'</span></div><div class="ot-review-controls"><button class="ot-button" data-action="video" data-id="'+id+'">인증 영상 보기</button>'+voteControls+'</div><div class="ot-video-host" id="video-'+id+'"></div><div class="ot-votes">'+votes+'</div>'+completion+'</article>';
  }
  function render(){
    const reviews=state.reviews.filter(r=>filter==='ALL'||r.status===filter);
    document.getElementById('pendingCount').textContent=state.reviews.filter(r=>r.status==='IN_REVIEW').length+'건 대기';
    reviewList.innerHTML=reviews.length?reviews.map(reviewHtml).join(''):'<div class="ot-empty">'+(filter==='IN_REVIEW'?'검토 대기 중인 영상이 없습니다.':'해당 상태의 영상이 없습니다.')+'</div>';
    media.forEach((value,id)=>{const host=document.getElementById('video-'+id);if(host)attachVideo(host,value.url,id);});
    document.getElementById('inviteList').innerHTML=state.invites.length?state.invites.map(invite=>{
      const active=!invite.revoked_at&&Date.parse(invite.expires_at)>Date.now();
      const label=invite.review_id?'등록 완료':active?'등록 대기':invite.revoked_at?'사용 중지':'만료';
      return '<div class="ot-invite-item"><div>'+esc(invite.somoim_nickname||'닉네임 미입력')+' · '+label+'<small>'+when(invite.created_at)+' 발급 / '+when(invite.expires_at)+' 만료</small></div>'+(active&&!invite.review_id?'<button class="ot-button ot-danger" data-action="revoke" data-invite="'+esc(invite.id)+'">링크 중지</button>':'')+'</div>';
    }).join(''):'<p class="ot-note">발급된 등록 링크가 없습니다.</p>';
    document.getElementById('operatorAccessPanel').hidden=!state.actor.isAdmin;
    document.getElementById('operatorAccessList').innerHTML=state.actor.isAdmin?state.operators.map(op=>'<div class="ot-invite-item"><div>'+esc(op.name)+'<small>'+(op.ot_access?'OT 검토 권한 있음':op.has_account?'관리자 계정 확인 필요':'개인 계정 연결 필요')+'</small></div><button type="button" class="ot-button'+(op.ot_access?' ot-danger':'')+'" data-action="operator_access" data-member="'+Number(op.id)+'" data-enabled="'+(!op.ot_access)+'" '+(!op.has_account?'disabled':'')+'>'+(op.ot_access?'권한 회수':'권한 부여')+'</button></div>').join(''):'';
  }
  function attachVideo(host,url,id){
    host.replaceChildren();const video=document.createElement('video');video.controls=true;video.preload='metadata';video.playsInline=true;video.setAttribute('controlsList','nodownload');video.src=url;
    const close=document.createElement('button');close.type='button';close.className='ot-button';close.textContent='영상 닫기';close.dataset.action='close_video';close.dataset.id=String(id);host.append(video,close);
  }
  function denied(error){
    if(error.status===401||error.status===403){clearMedia();state=null;dashboard.hidden=true;login.hidden=false;reviewList.replaceChildren();document.getElementById('refreshButton').hidden=true;}
    say(error.message,'error');
  }
  async function refresh(showMessage=true,background=false){
    if(refreshing||(background&&(media.size||reviewList.contains(document.activeElement))))return;refreshing=true;
    try{state=await request({action:'list'});login.hidden=true;dashboard.hidden=false;document.getElementById('refreshButton').hidden=false;document.getElementById('operatorName').textContent=state.actor.name;render();document.getElementById('lastRefreshed').textContent=when(new Date().toISOString())+' 확인';if(showMessage)say('운영진 전용 목록입니다. 영상 등록 후 익일 안내될 수 있습니다.');}
    catch(error){denied(error);}finally{refreshing=false;}
  }
  document.getElementById('adminLoginForm').addEventListener('submit',async event=>{
    event.preventDefault();const button=document.getElementById('adminLoginButton');button.disabled=true;
    try{const {error}=await db.auth.signInWithPassword({email:document.getElementById('adminEmail').value.trim(),password:document.getElementById('adminPassword').value});if(error)throw new Error('이메일과 비밀번호를 확인해 주세요.');document.getElementById('adminPassword').value='';await refresh();}catch(error){say(error.message,'error');}finally{button.disabled=false;}
  });
  document.getElementById('inviteForm').addEventListener('submit',async event=>{
    event.preventDefault();const button=document.getElementById('inviteButton');button.disabled=true;
    try{const result=await request({action:'issue_invite',somoim_nickname:document.getElementById('inviteNickname').value.trim()});document.getElementById('newInviteUrl').value=result.url;document.getElementById('newInviteExpires').textContent='1회 등록용 · '+when(result.invite.expires_at)+'까지 유효합니다. 이 링크는 지금 복사해 주세요.';document.getElementById('newInviteOutput').hidden=false;await refresh(false);say('등록 링크를 만들었습니다. 가입 인사 댓글로 안내해 주세요.','success');}catch(error){denied(error);}finally{button.disabled=false;}
  });
  document.getElementById('copyInviteButton').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(document.getElementById('newInviteUrl').value);say('등록 링크를 복사했습니다.','success');}catch(_){document.getElementById('newInviteUrl').select();say('링크를 선택했습니다. 직접 복사해 주세요.');}});
  document.getElementById('reviewFilters').addEventListener('click',event=>{const button=event.target.closest('[data-filter]');if(!button||!state)return;filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b===button));render();});
  dashboard.addEventListener('click',async event=>{
    const button=event.target.closest('[data-action]');if(!button||!state||actionBusy)return;
    const action=button.dataset.action,id=Number(button.dataset.id);
    if(action==='close_video'){const value=media.get(id);if(value)URL.revokeObjectURL(value.url);media.delete(id);document.getElementById('video-'+id)?.replaceChildren();return;}
    actionBusy=true;button.disabled=true;
    try{
      if(action==='video'){if(!media.has(id)){const blob=await request({action:'video',review_id:id},true);media.set(id,{url:URL.createObjectURL(blob)});}attachVideo(document.getElementById('video-'+id),media.get(id).url,id);}
      if(action==='vote'){const voter=state.actor.isAdmin?Number(document.getElementById('voter-'+id).value):state.actor.memberId;if(!voter)throw new Error('운영진을 선택해 주세요.');await request({action:'vote',review_id:id,voter_member_id:voter,decision:button.dataset.decision});await refresh(false);say('심사 의견을 저장했습니다.','success');}
      if(action==='revoke'){if(!confirm('이 등록 링크를 중지할까요? 신규 가입자는 이 링크로 영상을 등록할 수 없게 됩니다.'))return;await request({action:'revoke_invite',invite_id:button.dataset.invite});await refresh(false);say('등록 링크를 중지했습니다.','success');}
      if(action==='complete'){const memberId=Number(document.getElementById('member-'+id).value);if(!memberId)throw new Error('최종 가입 완료 회원을 선택해 주세요.');if(!confirm('선택한 회원이 이 신규 가입자와 같은 사람인지 확인했나요?'))return;await request({action:'complete',review_id:id,member_id:memberId});await refresh(false);say('최종 가입 완료 회원과 연결했습니다.','success');}
      if(action==='operator_access'){const enabled=button.dataset.enabled==='true';if(!confirm(enabled?'본인 운영진 계정임을 확인했나요? 이 계정에서 신규 가입자의 영상을 검토할 수 있게 됩니다.':'이 운영진의 OT 검토 권한을 회수할까요?'))return;await request({action:'operator_access',member_id:Number(button.dataset.member),enabled});await refresh(false);say(enabled?'OT 검토 권한을 부여했습니다.':'OT 검토 권한을 회수했습니다.','success');}
    }catch(error){denied(error);}finally{actionBusy=false;if(button.isConnected)button.disabled=false;}
  });
  document.getElementById('refreshButton').addEventListener('click',()=>refresh());
  document.getElementById('retryNotificationButton').addEventListener('click',async event=>{event.target.disabled=true;try{await request({action:'retry_notifications'});await refresh(false);say('대기 중인 알림을 재시도했습니다.');}catch(error){denied(error);}finally{event.target.disabled=false;}});
  db.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){clearMedia();state=null;dashboard.hidden=true;login.hidden=false;reviewList.replaceChildren();document.getElementById('operatorName').textContent='';document.getElementById('newInviteUrl').value='';document.getElementById('newInviteOutput').hidden=true;document.getElementById('refreshButton').hidden=true;say('로그아웃됐습니다. 운영진 계정으로 다시 로그인해 주세요.');}});
  window.addEventListener('pagehide',clearMedia);
  refresh().then(()=>{if(focusId&&state){filter='ALL';document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter==='ALL'));render();document.getElementById('review-'+focusId)?.scrollIntoView({behavior:'smooth',block:'start'});}});
  setInterval(()=>{if(state&&!actionBusy&&!document.hidden)refresh(false,true);},30000);
})();
