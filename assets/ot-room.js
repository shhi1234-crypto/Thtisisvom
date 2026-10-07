(function(){
  'use strict';
  const base='https://aqfmhqultzpakfqwzulj.supabase.co';
  const db=supabase.createClient(base,'sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R');
  const endpoint=base+'/functions/v1/ot-room';
  const message=document.getElementById('roomMessage'),card=document.getElementById('uploadCard');
  const accountCard=document.getElementById('accountCard'),loginCard=document.getElementById('roomLogin');
  const form=document.getElementById('uploadForm'),button=document.getElementById('submitButton');
  const label=document.getElementById('windowLabel'),progress=document.getElementById('uploadProgress');
  let token=new URLSearchParams(location.hash.slice(1)).get('token')||'';
  try{if(token){sessionStorage.setItem('vom-ot-invite',token);history.replaceState(null,'',location.pathname);}else token=sessionStorage.getItem('vom-ot-invite')||'';}catch(_){}
  let info=null,busy=false,offset=0;
  function say(text,kind=''){message.textContent=text;message.className='ot-message'+(kind?' '+kind:'');}
  async function authHeaders(){const {data}=await db.auth.getSession();const h={'x-ot-invite':token};if(data.session)h.Authorization='Bearer '+data.session.access_token;document.getElementById('roomLogout').hidden=!data.session;return h;}
  async function request(body,slug='ot-room'){
    const response=await fetch(base+'/functions/v1/'+slug,{method:'POST',headers:{...await authHeaders(),'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store',referrerPolicy:'no-referrer'});
    let data;try{data=await response.json();}catch(_){throw new Error('서버 응답을 확인하지 못했습니다.');}
    if(!response.ok)throw new Error(data.error||'요청을 처리하지 못했습니다.');return data;
  }
  function updateWindow(){
    if(!info||info.submitted||!info.account_exists||info.login_required)return;
    const hour=Number(new Intl.DateTimeFormat('en',{timeZone:'Asia/Seoul',hour:'2-digit',hourCycle:'h23'}).format(new Date(Date.now()+offset)));
    const open=hour>=9&&hour<18;label.textContent=open?'등록 가능 · 09:00~18:00':'등록 시간 종료';label.className='ot-tag'+(open?'':' closed');button.disabled=busy||!open;
    if(!busy)button.textContent=open?'영상 등록하기':'오전 9시부터 등록할 수 있어요';
  }
  async function refresh(){
    const data=await request({action:'info'});info=data;offset=Date.parse(data.server_time)-Date.now();card.hidden=true;accountCard.hidden=true;loginCard.hidden=true;
    if(info.login_required){loginCard.hidden=false;say('신청할 때 설정한 개인 계정으로 로그인해 주세요.');return;}
    if(!info.account_exists){accountCard.hidden=false;document.getElementById('accountNickname').value=info.somoim_nickname||'';say('아이디·개인 비밀번호와 가입 정보를 먼저 설정해 주세요.');return;}
    if(info.submitted){
      const statuses={IN_REVIEW:'영상이 등록됐습니다. 운영진 확인 후 익일 안내될 수 있습니다.',APPROVED:'영상 검토가 완료됐습니다. 가입 상태를 다시 확인해 주세요.',REJECTED:'영상 검토가 완료됐습니다. 자세한 안내는 운영진에게 확인해 주세요.',JOINED:'가입이 완료되어 회원 프로필이 생성됐습니다. 같은 계정으로 멤버스와 스케줄을 이용해 주세요.'};
      say(statuses[info.status]||'운영진 확인을 기다려 주세요.','success');return;
    }
    card.hidden=false;document.getElementById('candidateName').value=info.profile.candidate_name;document.getElementById('somoimNickname').value=info.profile.somoim_nickname;
    say(info.registration_open?'가입 계정이 설정됐습니다. 인증 영상을 등록해 주세요.':'계정은 설정됐습니다. 영상은 오전 9시부터 오후 6시 전까지 등록해 주세요.');updateWindow();
  }
  async function upload(data){const h=await authHeaders();return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('POST',endpoint);Object.entries(h).forEach(([key,value])=>xhr.setRequestHeader(key,value));xhr.timeout=180000;
    xhr.upload.onprogress=e=>{if(e.lengthComputable){progress.value=Math.round(e.loaded/e.total*100);button.textContent=progress.value>=100?'등록 확인 중...':'업로드 중 · '+progress.value+'%';}};
    xhr.onload=()=>{let result;try{result=JSON.parse(xhr.responseText);}catch(_){reject(new Error('등록 상태를 다시 확인해 주세요.'));return;}if(xhr.status>=200&&xhr.status<300)resolve(result);else reject(new Error(result.error||'영상을 등록하지 못했습니다.'));};
    xhr.onerror=()=>reject(new Error('연결이 끊겼습니다. 등록 상태를 확인해 주세요.'));xhr.ontimeout=()=>reject(new Error('전송 시간이 길어졌습니다. 등록 상태를 확인해 주세요.'));xhr.send(data);
  });}
  document.getElementById('accountForm').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;const f=event.target;if(!f.reportValidity())return;const values=Object.fromEntries(new FormData(f));
    if(values.password!==values.password_confirm){say('비밀번호 확인이 일치하지 않습니다.','error');return;}
    busy=true;const b=document.getElementById('accountButton');b.disabled=true;
    try{const result=await request({...values,action:'create_account',consent:true});const {error}=await db.auth.signInWithPassword({email:result.login_email,password:'VOM:'+values.password});if(error)throw new Error('계정은 설정됐습니다. 신청 계정으로 다시 로그인해 주세요.');f.reset();await refresh();}
    catch(error){say(error.message,'error');}finally{busy=false;b.disabled=false;updateWindow();}
  });
  document.getElementById('roomLoginForm').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;busy=true;const b=event.target.querySelector('button');b.disabled=true;
    try{const result=await request({action:'login',...Object.fromEntries(new FormData(event.target))},'vom-access');const {error}=await db.auth.setSession(result.session);if(error)throw error;event.target.reset();if(result.state==='APPROVED'){location.href='/me/';return;}await refresh();}catch(error){say(error.message,'error');}finally{busy=false;b.disabled=false;}
  });
  document.getElementById('videoFile').addEventListener('change',event=>{const f=event.target.files[0];document.getElementById('fileSummary').textContent=f?f.name+' · '+(f.size/1024/1024).toFixed(1)+'MB':'';});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||button.disabled||!form.reportValidity())return;const file=document.getElementById('videoFile').files[0];if(!file||!file.size||file.size>50*1024*1024){say('영상은 0바이트보다 크고 50MB 이하여야 합니다.','error');return;}
    busy=true;button.disabled=true;progress.hidden=false;progress.value=0;
    try{const result=await upload(new FormData(form));info={...info,submitted:true,status:result.status};card.hidden=true;say(result.message,'success');await refresh();}catch(error){try{await refresh();}catch(_){}if(!info?.submitted)say(error.message,'error');}finally{busy=false;progress.hidden=true;updateWindow();}
  });
  document.getElementById('roomLogout').addEventListener('click',async()=>{await db.auth.signOut();location.reload();});
  refresh().catch(error=>{card.hidden=true;accountCard.hidden=true;loginCard.hidden=false;say(error.message);});
  setInterval(updateWindow,1000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!busy)refresh().catch(error=>say(error.message,'error'));});
})();
