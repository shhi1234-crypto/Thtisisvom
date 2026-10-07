(function(){
  const base='https://aqfmhqultzpakfqwzulj.supabase.co';
  const db=supabase.createClient(base,'sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R');
  const card=document.getElementById('activationCard'),message=document.getElementById('activationMessage');
  let token=new URLSearchParams(location.hash.slice(1)).get('token')||'',busy=false;
  try{if(token){sessionStorage.setItem('vom-activation-token',token);history.replaceState(null,'',location.pathname);}else token=sessionStorage.getItem('vom-activation-token')||'';}catch(_){}
  async function request(body){const r=await fetch(base+'/functions/v1/vom-access',{method:'POST',headers:{'Content-Type':'application/json','x-ot-invite':token},body:JSON.stringify(body),cache:'no-store',referrerPolicy:'no-referrer'});const d=await r.json();if(!r.ok)throw new Error(d.error||'설정 링크를 확인해 주세요.');return d;}
  request({action:'activation_info'}).then(d=>{card.hidden=false;message.textContent=d.member_name+'님의 개인 계정을 설정합니다.';}).catch(e=>{message.textContent=e.message;});
  document.getElementById('activationForm').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!event.target.reportValidity())return;const f=Object.fromEntries(new FormData(event.target));if(f.password!==f.confirm_password){message.textContent='비밀번호 확인이 일치하지 않습니다.';return;}
    busy=true;const b=event.target.querySelector('button');b.disabled=true;
    try{const d=await request({action:'activate',password:f.password});card.hidden=true;const {error}=await db.auth.signInWithPassword({email:d.login_email,password:'VOM:'+f.password});if(error){message.textContent='비밀번호가 설정됐습니다. MY VOM에서 등록된 이름과 새 비밀번호로 로그인해 주세요.';return;}try{sessionStorage.removeItem('vom-activation-token');}catch(_){}location.replace('/me/');}catch(e){message.textContent=e.message;}finally{busy=false;b.disabled=false;}
  });
})();
