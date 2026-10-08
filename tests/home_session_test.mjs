import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('async function restoreAdmin(){'),html.indexOf('function setAdminUI(active){'));

for(const mode of ['guest','member','admin','lookup_error']){
  test(`opening home preserves ${mode} session and only enables verified admin controls`,async()=>{
    const session=mode==='guest'?null:{user:{id:'own-auth-id'},access_token:'own-session'};
    let signedOut=0,adminUI,lookups=0;
    const db={auth:{getSession:async()=>({data:{session}}),signOut:async()=>{signedOut++;}},from:table=>{
      assert.equal(table,'admins');lookups++;
      return {select:()=>({eq:(column,value)=>{
        assert.equal(column,'user_id');assert.equal(value,session.user.id);
        return {maybeSingle:async()=>({data:mode==='admin'?{user_id:value}:null,error:mode==='lookup_error'?{message:'unavailable'}:null})};
      }})};
    }};
    await runInNewContext(source+'\nrestoreAdmin();',{db,setAdminUI:active=>{adminUI=active;}});
    assert.equal(signedOut,0,'opening the public homepage must never sign out a member');
    assert.equal(adminUI,mode==='admin');assert.equal(lookups,mode==='guest'?0:1);
  });
}
