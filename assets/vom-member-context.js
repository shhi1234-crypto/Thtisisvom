/* Read the live Supabase session, not a possibly expired stored access token. */
(function(){
  'use strict';
  const url='https://aqfmhqultzpakfqwzulj.supabase.co';
  const key='sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R';
  const guest={approved:false,isAdmin:false,member:null};
  let fallbackClient=null, inFlight=null, inFlightToken='';

  function authClient(){
    // Reuse a page's Supabase client so token refresh remains consistent.
    try{
      if(typeof db!=='undefined' && db?.auth?.getSession)return db;
    }catch(_){}
    if(!window.supabase?.createClient)return null;
    if(!fallbackClient)fallbackClient=window.supabase.createClient(url,key);
    return fallbackClient;
  }

  async function currentToken(){
    const client=authClient();
    if(client){
      const {data,error}=await client.auth.getSession();
      if(error)throw error;
      return data?.session?.access_token||'';
    }
    // Some public pages don't load the SDK; preserve their existing behavior.
    try{
      return JSON.parse(localStorage.getItem('sb-aqfmhqultzpakfqwzulj-auth-token')||'null')?.access_token||'';
    }catch(_){return '';}
  }

  let observedAuthClient=null;
  let observedAuthSubscription=null;

  function notifyMemberAccessChange(){
    inFlight=null;
    inFlightToken='';
    window.dispatchEvent(new CustomEvent('vom-member-access-changed'));
  }

  function observeAuthChanges(){
    const client=authClient();
    if(!client||client===observedAuthClient||!client.auth?.onAuthStateChange)return;
    try{
      observedAuthSubscription?.unsubscribe?.();
      observedAuthClient=client;
      const result=client.auth.onAuthStateChange(function(event){
        if(event==='INITIAL_SESSION')return;
        notifyMemberAccessChange();
      });
      observedAuthSubscription=result?.data?.subscription||null;
    }catch(_){}
  }

  window.vomGetMemberAccess=async function(){
    observeAuthChanges();
    let token='';
    try{token=await currentToken();}catch(_){return guest;}
    if(!token)return guest;
    if(inFlight&&inFlightToken===token)return inFlight;

    inFlightToken=token;
    const request=fetch(url+'/functions/v1/vom-access',{
      method:'POST',
      headers:{apikey:key,'Content-Type':'application/json',Authorization:'Bearer '+token},
      body:JSON.stringify({action:'context'}),
      cache:'no-store',signal:AbortSignal.timeout(15000)
    }).then(async response=>{
      if(!response.ok)return guest;
      const data=await response.json();
      const approved=['APPROVED','PASSWORD_CHANGE_REQUIRED'].includes(data.state);
      return {
        approved,
        isAdmin:approved&&data.is_admin===true,
        member:approved?data.member:null
      };
    }).catch(()=>guest);
    inFlight=request;
    try{return await request;}
    finally{if(inFlight===request)inFlight=null;}
  };
})();
