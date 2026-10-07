/* A saved token alone never makes a visitor an approved member. */
(function(){
  'use strict';
  let cachedToken='',pending=null;
  window.vomGetMemberAccess=function(){
    let token='';try{token=JSON.parse(localStorage.getItem('sb-aqfmhqultzpakfqwzulj-auth-token')||'null')?.access_token||'';}catch(_){}
    if(!token)return Promise.resolve({approved:false,isAdmin:false,member:null});
    if(pending&&cachedToken===token)return pending;
    cachedToken=token;
    pending=fetch('https://aqfmhqultzpakfqwzulj.supabase.co/functions/v1/vom-access',{method:'POST',headers:{apikey:'sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R','Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action:'context'}),cache:'no-store',signal:AbortSignal.timeout(15000)})
      .then(async response=>{if(!response.ok)return {approved:false,isAdmin:false,member:null};const data=await response.json();return {approved:data.state==='APPROVED',isAdmin:data.state==='APPROVED'&&data.is_admin===true,member:data.state==='APPROVED'?data.member:null};})
      .catch(()=>{pending=null;return {approved:false,isAdmin:false,member:null};});
    return pending;
  };
})();
