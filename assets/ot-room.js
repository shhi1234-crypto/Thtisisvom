(function(){
  'use strict';
  const endpoint='https://aqfmhqultzpakfqwzulj.supabase.co/functions/v1/ot-room';
  const message=document.getElementById('roomMessage');
  const card=document.getElementById('uploadCard');
  const form=document.getElementById('uploadForm');
  const button=document.getElementById('submitButton');
  const label=document.getElementById('windowLabel');
  const progress=document.getElementById('uploadProgress');
  const fragment=new URLSearchParams(location.hash.slice(1));
  let token=fragment.get('token')||'';
  try{
    if(token){sessionStorage.setItem('vom-ot-invite',token);history.replaceState(null,'',location.pathname);}
    else token=sessionStorage.getItem('vom-ot-invite')||'';
  }catch(_){ /* A fresh fragment link still works when browser storage is unavailable. */ }
  let info=null,busy=false,offset=0;

  function say(text,kind=''){message.textContent=text;message.className='ot-message'+(kind?' '+kind:'');}
  function updateWindow(){
    if(!info||info.submitted)return;
    const hour=Number(new Intl.DateTimeFormat('en',{timeZone:'Asia/Seoul',hour:'2-digit',hourCycle:'h23'}).format(new Date(Date.now()+offset)));
    const open=hour>=9&&hour<18;
    label.textContent=open?'등록 가능 · 09:00~18:00':'등록 시간 종료';
    label.className='ot-tag'+(open?'':' closed');
    button.disabled=busy||!open;
    if(!busy)button.textContent=open?'영상 등록하기':'오전 9시부터 등록할 수 있어요';
  }
  async function refresh(){
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-ot-invite':token},body:JSON.stringify({action:'info'}),cache:'no-store',referrerPolicy:'no-referrer'});
    let data;try{data=await response.json()}catch(_){throw new Error('등록 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.')}
    if(!response.ok)throw new Error(data.error||'등록 링크를 확인해 주세요.');
    info=data;offset=Date.parse(data.server_time)-Date.now();
    if(info.submitted){
      card.hidden=true;
      const statuses={IN_REVIEW:'영상이 등록됐습니다. 운영진 확인 후 익일 안내될 수 있으니 최종 안내를 기다려 주세요.',APPROVED:'영상 검토가 완료됐습니다. 운영진의 최종 가입 안내를 기다려 주세요.',REJECTED:'영상 검토가 완료됐습니다. 자세한 안내는 운영진에게 확인해 주세요.',JOINED:'최종 가입 확인이 완료됐습니다. 운영진이 안내한 회원 이용 방법을 확인해 주세요.'};
      say(statuses[info.status]||'영상이 등록됐습니다. 운영진 안내를 기다려 주세요.','success');
    }else{
      card.hidden=false;
      if(!document.getElementById('somoimNickname').value)document.getElementById('somoimNickname').value=info.somoim_nickname||'';
      say(info.registration_open?'이름과 소모임 닉네임을 입력한 뒤 인증 영상을 등록해 주세요.':'지금은 영상 등록 시간이 아닙니다. 한국시간 오전 9시부터 오후 6시 전까지 등록해 주세요.');
      updateWindow();
    }
  }
  function upload(data){return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('POST',endpoint);xhr.setRequestHeader('x-ot-invite',token);xhr.timeout=180000;
    xhr.upload.onprogress=event=>{if(event.lengthComputable){progress.value=Math.round(event.loaded/event.total*100);button.textContent=progress.value>=100?'등록을 확인하는 중...':'영상 업로드 중 · '+progress.value+'%';}};
    xhr.onload=()=>{let result;try{result=JSON.parse(xhr.responseText)}catch(_){reject(new Error('등록 결과를 확인하지 못했습니다. 상태를 다시 확인해 주세요.'));return}if(xhr.status>=200&&xhr.status<300)resolve(result);else reject(new Error(result.error||'영상을 등록하지 못했습니다.'));};
    xhr.onerror=()=>reject(new Error('연결이 끊겼습니다. 등록 상태를 확인한 뒤 다시 시도해 주세요.'));
    xhr.ontimeout=()=>reject(new Error('전송 시간이 길어졌습니다. 등록 상태를 확인한 뒤 다시 시도해 주세요.'));
    xhr.send(data);
  });}
  document.getElementById('videoFile').addEventListener('change',event=>{
    const file=event.target.files[0];document.getElementById('fileSummary').textContent=file?file.name+' · '+(file.size/1024/1024).toFixed(1)+'MB':'';
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||button.disabled||!form.reportValidity())return;
    const file=document.getElementById('videoFile').files[0];
    if(!file||!file.size||file.size>50*1024*1024){say('영상은 0바이트보다 크고 50MB 이하여야 합니다.','error');return;}
    busy=true;button.disabled=true;button.textContent='영상 업로드 중...';progress.hidden=false;progress.value=0;
    try{const result=await upload(new FormData(form));info={...info,submitted:result.submitted,status:result.status};card.hidden=true;say(result.message||'영상이 등록됐습니다. 운영진 안내를 기다려 주세요.','success');try{await refresh();}catch(_){ }}
    catch(error){try{await refresh();}catch(_){ }if(!info?.submitted)say(error.message,'error');}
    finally{busy=false;progress.hidden=true;updateWindow();}
  });
  if(!/^[a-f0-9]{64}$/.test(token)){say('운영진이 안내한 개별 등록 링크로 들어와 주세요.','error');return;}
  refresh().catch(error=>{card.hidden=true;say(error.message,'error');});
  setInterval(updateWindow,1000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!busy)refresh().catch(error=>say(error.message,'error'));});
})();
