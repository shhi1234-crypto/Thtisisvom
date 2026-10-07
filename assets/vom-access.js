/* Route convenience only. Database RLS and Edge Auth checks enforce access. */
(function(){
  'use strict';
  const path=location.pathname;
  if(!/^\/(members|calendar|schedule)(\/|$)/.test(path))return;
  const hide=document.createElement('style');hide.id='vom-private-loading';hide.textContent='body{visibility:hidden!important}';document.head.appendChild(hide);
  const db=supabase.createClient('https://aqfmhqultzpakfqwzulj.supabase.co','sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R');
  function login(){location.replace('/me/?next='+encodeURIComponent(path+location.search));}
  window.vomAccessReady=(async()=>{
    try{
      const {data}=await db.auth.getSession();if(!data.session){login();return false;}
      const response=await fetch('https://aqfmhqultzpakfqwzulj.supabase.co/functions/v1/vom-access',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token},body:JSON.stringify({action:'context'}),cache:'no-store'});
      if(!response.ok){login();return false;}
      const result=await response.json();
      if(result.state==='PENDING'){location.replace('/ot-room/');return false;}
      if(result.state!=='APPROVED'){login();return false;}
      hide.remove();return true;
    }catch(_){login();return false;}
  })();
})();
