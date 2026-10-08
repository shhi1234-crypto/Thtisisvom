import { ApiError, isRegistrationOpen, newToken, tokenHash, validateVideo, validatePhoto, signupDetails, mediaLink } from "../supabase/functions/_shared/ot-core.ts";
import { handle as room } from "../supabase/functions/ot-room/index.ts";
import { handle as access } from "../supabase/functions/vom-access/index.ts";
import { handle as review } from "../supabase/functions/ot-review/index.ts";
import { approvalSubscription } from "../supabase/functions/_shared/public-signup.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition { if (!condition) throw new Error(message); }
async function status(response: Response, expected: number) { assert(response.status === expected, "expected " + expected + ", got " + response.status + ": " + await response.clone().text()); }
const token = "a".repeat(64);
const userId = "b".repeat(36);
const inviteId = "8d98f633-2f22-4cd5-9a8b-690228e125a5";
const openNow = () => new Date("2026-10-07T01:00:00Z");

// A small behavior fake covers trust boundaries; database atomicity is tested
// separately against PostgreSQL with the actual migration and existing schema.
function fake(options: Record<string, any> = {}) {
  const state = { removed: [] as string[], uploaded: [] as string[], uploadedTypes: [] as string[], rpcCalls: [] as any[], operations: [] as any[], committed: false, reserved:false, photoPath:null as string|null, deletedUsers:[] as string[] };
  const user = options.user ?? { id: userId };
  function query(table: string) {
    let operation = "select", input: any, columns = "", filters: any[] = [];
    const q: any = {};
    for (const name of ["eq", "is", "gt", "lte", "or", "in", "order", "limit"]) q[name] = (...args: any[]) => { filters.push([name, ...args]); return q; };
    q.select = (value: string) => { columns = value; return q; };
    q.update = (value: any) => { operation = "update"; input = value; return q; };
    q.insert = (value: any) => { operation = "insert"; input = value; return q; };
    q.delete = () => {operation='delete';return q;};
    function result() {
      state.operations.push({ table, operation, input, columns, filters });
      if (table === "admins") return { data: options.admin ? { user_id: userId } : null, error: null };
      if (table === "ot_signup_reservations") return {data:options.reservation||(state.reserved?{invite_id:inviteId}:null),error:null};
      if (table === "members" && columns.includes("birth_date")) return {data:options.birthdays||[],error:null};
      if (table === "members") return { data: options.member || null, error: null };
      if (table === "ot_room_operator_access") return { data: options.member && options.operatorAccess !== false ? { member_id: options.member.id } : null, error: null };
      if (table === "ot_room_invites") {
        if (operation === "update") {
          if (input.upload_claim_id && options.reserveBusy) return { data: null, error: null };
          return { data: { id: inviteId }, error: null };
        }
        if (filters.some(f=>f[1]==="applicant_user_id"&&f[2]!== (options.ownerId||userId))) return {data:null,error:null};
        if (options.inviteMissing) return { data: null, error: null };
        return { data: { id: inviteId, expires_at: options.expiresAt || "2026-10-09T00:00:00Z", revoked_at: options.revoked ? "2026-10-06T00:00:00Z" : null, review_id: state.committed || options.submitted ? 1 : null, somoim_nickname: "VOM 새 회원", applicant_user_id: options.noAccount ? null : (options.ownerId || userId) }, error: null };
      }
      if (table === "ot_room_applicants") return { data:{auth_user_id:options.identity||userId,login_name:"new-vom",candidate_name:"신규 회원",somoim_nickname:"내 소모임 닉네임",member_id:null,form_version:options.formVersion||1,profile_photo_path:state.photoPath||options.photoPath||null},error:null };
      if (table === "member_account_settings") return {data:{must_change_password:!!options.mustChange},error:null};
      if (table === "ot_reviews") {
        if (operation === "update" && (input.notification_claimed_at || input.approval_notification_claimed_at)) return { data: null, error: null };
        return { data: { status: options.reviewStatus||"IN_REVIEW", created_at:"2026-10-08T00:00:00Z", video_source: options.videoSource||"FILE", video_url:options.videoUrl||null, video_file_path: "reviews/safe/video.mp4", completed_at: options.reviewCompleted||null }, error: null };
      }
      return { data: [], error: null };
    }
    q.maybeSingle = q.single = async () => result();
    q.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
    return q;
  }
  const client: any = {
    auth: { getUser: async () => ({ data: { user: options.unauthenticated ? null : user }, error: options.unauthenticated ? { message: "bad token" } : null }), admin:{createUser:async()=>({data:{user:options.createError?null:{id:"new-user"}},error:options.createError?{}:null}),deleteUser:async(id:string)=>{state.deletedUsers.push(id);return {error:null};}} },
    from: query,
    rpc: async (name: string, input: any) => {
      state.rpcCalls.push({ name, input });
      if(name==="vom_claim_login_attempt")return {data:options.blockLogin?false:true,error:null};
      if(name==="vom_ot_reserve_upload"||name==="vom_ot_reserve_link"){state.reserved=true;return {data:{scheduled_at:"2026-10-08T00:00:00Z"},error:options.reserveLost?{message:"lost"}:null};}
      if (name==="vom_ot_bind_account") return {data:null,error:null};
      if (name==="vom_ot_finalize_photo") {state.photoPath=input.p_file_path;return {data:null,error:options.photoCommitLost?{message:"lost"}:null};}
      if (options.commitLost) { state.committed = true; return { data: null, error: { message: "network failure" } }; }
      if (options.rpcClosed) return { data: null, error: { message: "room_closed" } };
      state.committed = true; return { data: { id: 1, status: "IN_REVIEW" }, error: null };
    },
    storage: { from: () => ({
      upload: async (path: string,body:Blob) => { state.uploaded.push(path);state.uploadedTypes.push(body.type); return { error: null }; },
      remove: async (paths: string[]) => { state.removed.push(...paths); return { error: null }; },
      download: async () => ({ data: new Blob([new Uint8Array([1,2,3])], { type: options.downloadType||"video/mp4" }), error: null }),
    }) },
  };
  return { client, state };
}
function infoRequest(candidateToken = token, authenticated = true) { return new Request("https://edge.invalid/ot-room", { method: "POST", headers: { "Content-Type": "application/json", "x-ot-invite": candidateToken, ...(authenticated?{Authorization:"Bearer legitimate-token"}:{}) }, body: JSON.stringify({ action: "info" }) }); }
function videoFile() { const bytes = new Uint8Array(24); bytes.set(new TextEncoder().encode("ftypisom"), 4); return new File([bytes], "voice.mp4", { type: "video/mp4" }); }
function uploadRequest(file = videoFile()) { const form = new FormData(); form.set("candidate_name", "신규 회원"); form.set("somoim_nickname", "내 소모임 닉네임"); form.set("consent", "yes"); form.set("video", file); return new Request("https://edge.invalid/ot-room", { method: "POST", headers: { "x-ot-invite": token, Authorization:"Bearer legitimate-token" }, body: form }); }
function operatorRequest(body: any, withToken = true) { return new Request("https://edge.invalid/ot-review", { method: "POST", headers: { "Content-Type": "application/json", ...(withToken ? { Authorization: "Bearer legitimate-token" } : {}) }, body: JSON.stringify(body) }); }

Deno.test("KST admission boundaries: 09:00 inclusive, 18:00 exclusive and midnight", () => {
  for (const [value, expected] of [["2026-10-06T23:59:59Z", false], ["2026-10-07T00:00:00Z", true], ["2026-10-07T08:59:59Z", true], ["2026-10-07T09:00:00Z", false], ["2026-10-07T15:00:00Z", false]] as const) assert(isRegistrationOpen(new Date(value)) === expected, value);
});
Deno.test("tokens have 256-bit random input and only hashes are persisted", async () => { const first = newToken(), second = newToken(); assert(/^[a-f0-9]{64}$/.test(first)); assert(first !== second); const hash = await tokenHash(first); assert(hash.length === 64 && hash !== first && hash === await tokenHash(first)); });
Deno.test("HTML renamed to mp4 and zero byte media are rejected", async () => { for (const file of [new File(["<html>evil</html>"], "looks.mp4", { type: "video/mp4" }), new File([], "empty.mp4")]) { let rejected = false; try { await validateVideo(file); } catch (e) { rejected = e instanceof ApiError; } assert(rejected); } });
Deno.test("room refuses missing, expired and revoked invitations", async () => { await status(await room(infoRequest("bad",false), fake().client, openNow), 404); for (const option of [{ inviteMissing: true }, { expiresAt: "2026-10-06T00:00:00Z" }, { revoked: true }]) await status(await room(infoRequest(), fake({...option,noAccount:true}).client, openNow), 404); });
Deno.test("applicant status works after closing and contains no media or internal identity", async () => { const response = await room(infoRequest(), fake({ submitted: true }).client, () => new Date("2026-10-07T10:00:00Z")); await status(response, 200); const data = await response.text(); assert(!/file_path|video_url|token_hash|userId|eligible_operator/.test(data)); assert(JSON.parse(data).submitted); });
Deno.test("18:00 upload rejected before file storage", async () => { const { client, state } = fake(); await status(await room(uploadRequest(), client, () => new Date("2026-10-07T09:00:00Z")), 403); assert(!state.uploaded.length && !state.rpcCalls.length); });
Deno.test("duplicate and concurrent uploads rejected", async () => { for (const option of [{ submitted: true }, { reserveBusy: true }]) { const { client, state } = fake(option); await status(await room(uploadRequest(), client, openNow), 409); assert(!state.uploaded.length); } });
Deno.test("valid upload commits existing OT review before notification", async () => { const { client, state } = fake(); const response = await room(uploadRequest(), client, openNow); await status(response, 201); assert(state.uploaded.length === 1 && !state.removed.length); assert(state.rpcCalls[0].name === "vom_ot_finalize_upload"); assert(state.rpcCalls[0].input.p_somoim_nickname === "내 소모임 닉네임"); assert(!/file_path|signedUrl|video_url/.test(await response.text())); });
Deno.test("closing during SQL commit removes unregistered bytes and frees claim", async () => { const { client, state } = fake({ rpcClosed: true }); await status(await room(uploadRequest(), client, openNow), 403); assert(state.removed.length === 1); assert(state.operations.some(o => o.input?.upload_claim_id === null)); });
Deno.test("ambiguous RPC response never deletes media from a successful commit", async () => { const { client, state } = fake({ commitLost: true }); await status(await room(uploadRequest(), client, openNow), 409); assert(state.committed && !state.removed.length); });
Deno.test("unauthenticated caller and ordinary member cannot list or play videos", async () => { const ordinary = { id: 2, name: "회원", role: "모임원", is_active: true }; for (const action of ["list", "video", "issue_invite"]) { await status(await review(operatorRequest({ action }, false), fake().client), 401); await status(await review(operatorRequest({ action, review_id: 1 }), fake({ member: ordinary }).client), 403); } });
Deno.test("inactive operator cannot read video", async () => { await status(await review(operatorRequest({ action: "video", review_id: 1 }), fake({ member: { id: 1, role: "운영진", is_active: false } }).client), 403); });
Deno.test("role label alone cannot grant OT access to a newly claimed operator account", async () => { await status(await review(operatorRequest({ action: "video", review_id: 1 }), fake({ member: { id: 1, role: "운영진", is_active: true }, operatorAccess: false }).client), 403); });
Deno.test("operator media is authenticated bytes with no URL and no-store", async () => { const response = await review(operatorRequest({ action: "video", review_id: 1 }), fake({ member: { id: 1, role: "운영진", is_active: true } }).client); await status(response, 200); assert(response.headers.get("Content-Type") === "video/mp4"); assert(response.headers.get("Cache-Control") === "no-store"); assert((await response.arrayBuffer()).byteLength === 3); });
Deno.test("operator cannot vote as another person or auto-complete membership", async () => { const { client, state } = fake({ member: { id: 1, name: "운영진", role: "운영진", is_active: true } }); await status(await review(operatorRequest({ action: "vote", review_id: 1, voter_member_id: 2, decision: "APPROVE" }), client), 403); await status(await review(operatorRequest({ action: "complete", review_id: 1, member_id: 2 }), client), 403); assert(!state.rpcCalls.length); });
Deno.test("shared administrator proxy vote remains available with audit actor", async () => { const { client, state } = fake({ admin: true }); await status(await review(operatorRequest({ action: "vote", review_id: 1, voter_member_id: 7, decision: "APPROVE" }), client), 200); assert(state.rpcCalls[0].input.p_member_id === 7 && state.rpcCalls[0].input.p_actor_id === userId); });
Deno.test("signed media URL route is retired", async () => { await status(await review(operatorRequest({ action: "signed_video_url", review_id: 1 }), fake({ admin: true }).client), 410); });

Deno.test("invite alone never exposes a bound account's private status",async()=>{
 const r=await room(infoRequest(token,false),fake({submitted:true}).client,openNow);await status(r,200);const data=await r.json();assert(data.login_required && !data.submitted && !data.profile && !data.status);
});
Deno.test("another applicant JWT cannot upload against this invite",async()=>{const {client,state}=fake({ownerId:"other-user"});await status(await room(uploadRequest(),client,openNow),401);assert(!state.uploaded.length);});
Deno.test("account signup requires an unused invitation, consent and strong password",async()=>{
 const request=(body:any)=>new Request("https://edge.invalid/ot-room",{method:"POST",headers:{"Content-Type":"application/json","x-ot-invite":token},body:JSON.stringify({action:"create_account",login_name:"new-vom",password:"abc12345",candidate_name:"테스트",somoim_nickname:"테스트별명",consent:true,birth_year:"1995",job:"회사원",busking_experience:"0",busking_experience_unit:"COUNT",...body})});
 await status(await room(request({}),fake().client,openNow),409);
 await status(await room(request({consent:false}),fake({noAccount:true}).client,openNow),400);
 await status(await room(request({password:"0000"}),fake({noAccount:true}).client,openNow),400);
 const {client,state}=fake({noAccount:true});await status(await room(request({}),client,openNow),201);assert(state.rpcCalls[0].name==="vom_ot_bind_account");assert(!("password" in state.rpcCalls[0].input.p_profile));
});
Deno.test("an unapproved Auth account remains pending regardless of role metadata",async()=>{
 const {client}=fake({user:{id:userId,user_metadata:{role:"admin"}}});
 const r=await access(operatorRequest({action:"context"}),client,{});await status(r,200);assert((await r.json()).state==="PENDING");
});

Deno.test("birth year is four digits, experience permits zero and years but rejects ages/future years/fractional counts",()=>{
 const base={birth_year:'1995',job:'회사원',busking_experience:'0',busking_experience_unit:'COUNT'};
 assert(signupDetails(base,openNow()).birth_year===1995);assert(signupDetails({...base,busking_experience:'1.5',busking_experience_unit:'YEARS'},openNow()).busking_experience===1.5);
 for(const changes of [{birth_year:'28'},{birth_year:'1995년'},{birth_year:'2050'},{job:''},{busking_experience:''},{busking_experience:'1.5'},{busking_experience:'-1'},{busking_experience_unit:'OTHER'}]){let rejected=false;try{signupDetails({...base,...changes},openNow());}catch(e){rejected=e instanceof ApiError;}assert(rejected,JSON.stringify(changes));}
});
Deno.test("live MP3/M4A/WAV/OGG/FLAC/AAC and video have detected MIME types; forged audio is refused",async()=>{
 const samples=[['ID3abcdefgh','live.mp3','audio/mpeg'],['OggSabcdefgh','live.ogg','audio/ogg'],['fLaCabcdefgh','live.flac','audio/flac'],['RIFF1234WAVEabcd','live.wav','audio/wav']];
 for(const [bytes,name,mime] of samples)assert((await validateVideo(new File([bytes],name))).mime===mime);
 const m4a=videoFile();assert((await validateVideo(new File([m4a],'live.m4a'))).mime==='audio/mp4');
 assert((await validateVideo(new File([new Uint8Array([255,241,80,0,0,0,0])],'live.aac'))).mime==='audio/aac');
 let rejected=false;try{await validateVideo(new File(['<html>not audio</html>'],'live.mp3',{type:'audio/mpeg'}));}catch(e){rejected=e instanceof ApiError;}assert(rejected);
});
function photoRequest(file=new File([new Uint8Array([255,216,255,224,0,0,0,0])],'me.jpg',{type:'image/jpeg'})){
 const form=new FormData();form.set('photo',file);return new Request('https://edge.invalid/ot-room?upload=photo',{method:'POST',headers:{'x-ot-invite':token,Authorization:'Bearer legitimate-token'},body:form});
}
Deno.test("photo needs its owner, validates bytes, stays private and can be saved after recording hours",async()=>{
 const {client,state}=fake({formVersion:2});const r=await room(photoRequest(),client,()=>new Date('2026-10-07T10:00:00Z'));await status(r,201);assert(state.rpcCalls[0].name==='vom_ot_finalize_photo');assert(state.uploaded[0].startsWith('profiles/'));assert(!state.removed.length);assert(!/file_path|signedUrl|photo_path/.test(await r.text()));
 await status(await room(photoRequest(),fake({ownerId:'other'}).client,openNow),401);
 const invalid=fake();await status(await room(photoRequest(videoFile()),invalid.client,openNow),400);assert(invalid.state.operations.some(o=>o.input?.upload_claim_id===null));
 let rejected=false;try{await validatePhoto(new File(['<svg></svg>'],'me.png'));}catch(e){rejected=e instanceof ApiError;}assert(rejected);
});
Deno.test("new registration cannot submit a recording without its photo",async()=>{const {client,state}=fake({formVersion:2});await status(await room(uploadRequest(),client,openNow),400);assert(!state.uploaded.length);});
Deno.test("ambiguous photo commit retains the committed picture",async()=>{const {client,state}=fake({photoCommitLost:true});await status(await room(photoRequest(),client,openNow),409);assert(state.photoPath&&!state.removed.length);});
Deno.test("ordinary members cannot read applicant photos; operator audio is authenticated bytes",async()=>{
 await status(await review(operatorRequest({action:'photo',review_id:1}),fake({member:{id:8,role:'모임원',is_active:true}}).client),403);
 const r=await review(operatorRequest({action:'media',review_id:1}),fake({admin:true,downloadType:'audio/mp4'}).client);await status(r,200);assert(r.headers.get('Content-Type')==='audio/mp4');assert(r.headers.get('Cache-Control')==='no-store');
});

Deno.test("detected audio MIME is applied to stored bytes even when the submitted File is mislabeled",async()=>{const {client,state}=fake();const file=new File(['ID3abcdefghijk'],'라이브.mp3',{type:'application/octet-stream'});await status(await room(uploadRequest(file),client,openNow),201);assert(state.uploadedTypes[0]==='audio/mpeg');assert(state.uploaded[0].endsWith('.mp3'));});

function publicRequest(changes:Record<string,any>={}) {
 const data=new FormData();
 for(const [key,value] of Object.entries({login_name:'public-test',password:'1234',password_confirm:'1234',phone:'01012345678',region:'서울',gender:'기타',candidate_name:'가입자',somoim_nickname:'가입별명',birth_year:'1995',job:'회사원',busking_experience:'0',busking_experience_unit:'COUNT',consent:'yes',live_confirmed:'yes',media_source:'FILE',...changes})) if(value!==null)data.set(key,value);
 if(!('photo' in changes))data.set('photo',new File([new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0])],'photo.png',{type:'image/png'}));
 if(!('video' in changes))data.set('video',videoFile());
 return new Request('https://edge.invalid/ot-room?signup=public',{method:'POST',body:data});
}
Deno.test('public registration opens without an invitation and info exposes no applicant data',async()=>{
 const response=await room(new Request('https://edge.invalid/ot-room?signup=public',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'info'})}),fake().client,openNow);
 await status(response,200);const data=await response.json();assert(data.public_signup&&data.registration_open&&!data.profile&&!data.invite_id);
});
Deno.test('public signup validates every required field and both files before creating an account',async()=>{
 for(const changes of [{photo:null},{video:null},{phone:''},{region:''},{gender:''},{password:'abcd',password_confirm:'abcd'},{job:''},{birth_year:'31'},{candidate_name:''},{somoim_nickname:''},{busking_experience:''},{consent:null},{password_confirm:'different'}]){
  const {client,state}=fake();await status(await room(publicRequest(changes),client,openNow),400);assert(!state.rpcCalls.length&&!state.uploaded.length&&!state.deletedUsers.length);
 }
});
Deno.test('public signup commits both private files together and returns no login session or media URL',async()=>{
 const {client,state}=fake();const response=await room(publicRequest(),client,openNow);await status(response,201);const body=await response.text();assert(state.uploaded.length===2&&state.rpcCalls.length===3);assert(JSON.parse(body).notification_token.length===64);assert(!/login_email|access_token|refresh_token|file_path|signedUrl/.test(body));assert(state.operations.some(x=>x.input?.signup_source==='PUBLIC'));assert(state.uploadedTypes.join(',')==='image/png,video/mp4');
});
Deno.test('public signup at 18:00 and a closing commit create durable reservations without reviews',async()=>{
 for(const [option,time] of [[{},()=>new Date('2026-10-07T09:00:00Z')],[{rpcClosed:true},openNow]] as const){
  const {client,state}=fake(option);const response=await room(publicRequest(),client,time);await status(response,201);const data=await response.json();assert(data.status==='SCHEDULED'&&data.scheduled_at==='2026-10-08T00:00:00Z');assert(state.reserved&&!state.committed&&state.uploaded.length===2&&!state.removed.length&&!state.deletedUsers.length);
 }
});
Deno.test('lost reservation receipt never removes reserved private files or account',async()=>{
 const {client,state}=fake({reserveLost:true});await status(await room(publicRequest(),client,()=>new Date('2026-10-07T09:00:00Z')),409);assert(state.reserved&&!state.removed.length&&!state.deletedUsers.length);
});
Deno.test('public signup never deletes a review after a lost commit response',async()=>{
 const {client,state}=fake({commitLost:true});await status(await room(publicRequest(),client,openNow),409);assert(state.committed&&!state.removed.length&&!state.deletedUsers.length);
});
Deno.test('approval device URLs reject localhost, private networks and arbitrary HTTPS hosts',()=>{
 const keys={p256dh:'A'.repeat(87),auth:'B'.repeat(22)};
 assert(approvalSubscription({endpoint:'https://fcm.googleapis.com/fcm/send/device',keys}).endpoint.includes('fcm'));
 for(const endpoint of ['http://fcm.googleapis.com/fcm/send/x','https://127.0.0.1/private','https://example.com/push','https://fcm.googleapis.com.evil.test/push','https://user:pass@web.push.apple.com/push','https://web.push.apple.com:8080/push']){let denied=false;try{approvalSubscription({endpoint,keys});}catch(error){denied=error instanceof ApiError;}assert(denied);}
});
Deno.test('member name picker uses the linked Auth email and preserves legacy personal passwords',async()=>{
 const {client}=fake({member:{id:8,auth_user_id:'linked-user',is_active:true}});client.auth.admin.getUserById=async(id:string)=>{assert(id==='linked-user');return {data:{user:{email:'original@member.thisisvom.app'}},error:null};};
 const credentials:any[]=[];const auth={auth:{signInWithPassword:async(value:any)=>{credentials.push(value);return value.password.startsWith('VOM:')?{data:{session:null},error:{}}:{data:{session:{user:{id:'linked-user'},access_token:'access',refresh_token:'refresh'}},error:null};}}};
 const response=await access(operatorRequest({action:'login',member_id:8,password:'old-password'}),client,auth);await status(response,200);assert(credentials.length===2&&credentials.every(x=>x.email==='original@member.thisisvom.app'));assert((await response.json()).state==='APPROVED');
});
Deno.test('pending applicants cannot receive a login session',async()=>{
 const {client}=fake();let signedOut=false;const auth={auth:{signInWithPassword:async()=>({data:{session:{user:{id:'pending-user'},access_token:'must-not-return',refresh_token:'must-not-return'}},error:null}),signOut:async()=>{signedOut=true;return {error:null};}}};
 const response=await access(operatorRequest({action:'login',login_name:'public-test',password:'abc12345'}),client,auth);await status(response,403);assert(signedOut&&!(await response.text()).includes('must-not-return'));
});

Deno.test('approval notifications require final approval, deliver once and retry transient failures',async()=>{
 const {notifyApproval}=await import('../supabase/functions/_shared/ot-push.ts');
 const webpush=(await import('npm:web-push@3.6.7')).default;const keys=webpush.generateVAPIDKeys();
 for(const approved of [false,true]){
  const row:any={approved,notified:null,lease:null,attempts:0};let deliveries=0,fail=false;
  const service={from:(table:string)=>{let operation='select',input:any;const filters:any[]=[];const q:any={};for(const method of ['eq','is','lte','or'])q[method]=(...args:any[])=>{filters.push([method,...args]);return q;};q.select=()=>q;q.update=(value:any)=>{operation='update';input=value;return q;};const result=()=>{
   if(table==='ot_reviews'){
    if(input?.approval_notification_claimed_at){if(!row.approved||row.notified||row.lease)return {data:null,error:null};row.lease=input.approval_notification_claimed_at;return {data:{id:1,approval_notification_attempts:row.attempts},error:null};}
    if(operation==='update'){row.notified=input.approval_notified_at;row.lease=input.approval_notification_claimed_at;row.attempts=input.approval_notification_attempts;}
   }
   if(table==='ot_room_invites')return {data:{id:inviteId,notification_push_enabled:true},error:null};
   if(table==='vom_push_config')return {data:{vapid_public_key:keys.publicKey,vapid_private_key:keys.privateKey,subject:'mailto:test@example.invalid'},error:null};
   if(table==='ot_applicant_push_subscriptions')return {data:{id:'subscription',endpoint:'https://fcm.googleapis.com/fcm/send/test',p256dh:'A'.repeat(87),auth:'B'.repeat(22)},error:null};
   return {data:null,error:null};};q.maybeSingle=async()=>result();q.then=(resolve:any,reject:any)=>Promise.resolve(result()).then(resolve,reject);return q;}};
  const send:any=async(_subscription:any,payload:string)=>{if(fail)throw {statusCode:503};deliveries++;assert(JSON.parse(payload).url.endsWith('/me/'));assert(!payload.includes('candidate_name'));};
  if(approved){fail=true;await notifyApproval(service,1,send);assert(!row.notified&&row.attempts===1&&!row.lease);fail=false;}
  await notifyApproval(service,1,send);await notifyApproval(service,1,send);assert(deliveries===(approved?1:0));if(approved)assert(row.notified&&row.attempts===2);
 }
});

Deno.test('login throttling rejects before attempting Auth and also covers selected member identities',async()=>{
 const {client}=fake({blockLogin:true,member:{id:8,auth_user_id:'linked-user',is_active:true}});let attempted=false;
 await status(await access(operatorRequest({action:'login',member_id:8,password:'1234'}),client,{auth:{signInWithPassword:()=>{attempted=true;}}}),429);assert(!attempted);
});

Deno.test('application results require the applicant password and never return a login session or another applicant data',async()=>{
 for(const [option,expected,stateValue] of [[{submitted:true},200,'IN_REVIEW'],[{submitted:true,reviewStatus:'APPROVED',reviewCompleted:'2026-10-08T01:00:00Z'},200,'APPROVED'],[{submitted:true,reviewStatus:'REJECTED'},200,'REJECTED'],[{reservation:{status:'WAITING',scheduled_at:'2026-10-09T00:00:00Z'}},200,'SCHEDULED'],[{ownerId:'other'},404,null],[{identity:'other'},401,null]] as any[]){
  const {client}=fake(option);let scope='';
  const auth={auth:{signInWithPassword:async()=>({error:null,data:{session:{user:{id:userId},access_token:'private-jwt',refresh_token:'private-refresh'}}}),signOut:async(value:any)=>{scope=value.scope;return {error:null};}}};
  const response=await access(operatorRequest({action:'application_status',login_name:'new-vom',password:'1234',member_id:8,auth_user_id:'other'}),client,auth);await status(response,expected);
  const text=await response.text();assert(scope==='local');assert(!/access_token|refresh_token|private-jwt|candidate_name|phone|video|file_path|eligible_operator/.test(text));
  if(expected===200){const data=JSON.parse(text);assert(data.state===stateValue);assert(data.check_at===(stateValue==='SCHEDULED'?'2026-10-09T03:00:00.000Z':'2026-10-08T03:00:00.000Z'));}
 }
 let called=false;const auth={auth:{signInWithPassword:async()=>{called=true;return {error:{},data:{session:null}};}}};
 await status(await access(operatorRequest({action:'application_status',login_name:'new-vom',password:'wrong'}),fake().client,auth),401);assert(called);
 called=false;await status(await access(operatorRequest({action:'application_status',login_name:'new-vom',password:'1234'}),fake({blockLogin:true}).client,auth),429);assert(!called);
});

Deno.test('new signup alerts name the applicant and retry failed operator devices without repeating successful ones',async()=>{
 const {notifyOT}=await import('../supabase/functions/_shared/ot-push.ts');
 const webpush=(await import('npm:web-push@3.6.7')).default,keys=webpush.generateVAPIDKeys();
 const delivered=new Set<number>(),sent:number[]=[];let fail=true,notified:any=null,lease:any=null;
 const subscriptions=[{id:1,vom_push_invites:{recipient_name:'운영진1'}},{id:2,vom_push_invites:{recipient_name:'운영진2'}},{id:3,vom_push_invites:{recipient_name:'다른 모임'}}].map(s=>({...s,endpoint:'https://fcm.googleapis.com/fcm/send/'+s.id,p256dh:'test',auth:'test'}));
 const service:any={from:(table:string)=>{let input:any,operation='select';const q:any={};for(const method of ['eq','is','lte','or','in','select'])q[method]=()=>q;q.update=(v:any)=>{operation='update';input=v;return q;};q.upsert=(v:any)=>{operation='upsert';input=v;return q;};const result=()=>{
  if(table==='ot_reviews'){
   if(input?.notification_claimed_at){if(notified||lease)return {data:null,error:null};lease=input.notification_claimed_at;return {data:{id:1,candidate_name:'홍길동',eligible_operator_ids:[1,2],notification_attempts:0},error:null};}
   if(input){notified=input.operator_notified_at;lease=null;}return {data:null,error:null};
  }
  if(table==='vom_push_config')return {data:{vapid_public_key:keys.publicKey,vapid_private_key:keys.privateKey,subject:'mailto:test@example.invalid'},error:null};
  if(table==='members')return {data:[{id:1,name:'운영진1'},{id:2,name:'운영진2'}],error:null};
  if(table==='vom_push_subscriptions')return {data:subscriptions,error:null};
  if(table==='ot_operator_push_deliveries'){if(operation==='upsert'){delivered.add(input.subscription_id);return {error:null};}return {data:[...delivered].map(subscription_id=>({subscription_id})),error:null};}
  return {data:null,error:null};};q.maybeSingle=async()=>result();q.then=(a:any,b:any)=>Promise.resolve(result()).then(a,b);return q;}};
 const send:any=async(sub:any,payload:string,options:any)=>{const id=Number(sub.endpoint.split('/').pop());sent.push(id);assert(id!==3);assert(JSON.parse(payload).body==='홍길동님이 신청했습니다.\n3시간 이내에 확인해 주세요.');assert(options.TTL===10800);if(id===2&&fail)throw {statusCode:503};};
 const first=await notifyOT(service,1,send);assert(first.pending&&!notified&&delivered.has(1));fail=false;
 const second=await notifyOT(service,1,send);assert(!second.pending&&!!notified);await notifyOT(service,1,send);assert(sent.join(',')==='1,2,2');
});

Deno.test('notification registration links can only be issued by an administrator for an active operator',async()=>{
 await status(await review(operatorRequest({action:'operator_push_invite',member_id:1}),fake({member:{id:1,name:'운영진',role:'운영진',is_active:true}}).client),403);
 await status(await review(operatorRequest({action:'operator_push_invite',member_id:1}),fake({admin:true}).client),400);
 const response=await review(operatorRequest({action:'operator_push_invite',member_id:1}),fake({admin:true,member:{id:1,name:'운영진',role:'운영진',is_active:true}}).client);await status(response,200);assert((await response.json()).url.startsWith('https://thisisvom.vercel.app/operator-alert/?t='));
});

Deno.test('public birthday summary contains only the next KST date, while people require approved login',async()=>{
 const {handle:birthdays,nextBirthday}=await import('../supabase/functions/birthday-summary/index.ts');
 assert(nextBirthday([{birth_date:'1995-01-01'}],new Date('2026-12-31T15:00:00Z'))==='2027-01-01');
 assert(nextBirthday([{birth_date:'2000-02-29'}],new Date('2026-03-01T00:00:00Z'))==='2028-02-29');
 const request=(action:string,auth=true)=>new Request('https://edge.invalid/birthday-summary',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer token'}:{})},body:JSON.stringify({action})});
 const options={birthdays:[{id:8,name:'Private birthday member',birth_date:'1990-10-08'}]};
 const publicResponse=await birthdays(request('summary',false),fake(options).client,openNow);await status(publicResponse,200);assert(JSON.stringify(await publicResponse.json())==='{"ok":true,"next_birthday":"2026-10-08"}');
 await status(await birthdays(request('people',false),fake(options).client,openNow),401);
 await status(await birthdays(request('people'),fake(options).client,openNow),403);
 const memberResponse=await birthdays(request('people'),fake({...options,member:{id:8,is_active:true,name:'회원'}}).client,openNow);await status(memberResponse,200);const data=await memberResponse.text();assert(data.includes('Private birthday member')&&!data.includes('1990')&&!data.includes('birth_date'));
});
Deno.test('reservation worker runs during registration hours, renews private claims and commits once',async()=>{
 const {processSignupReservations}=await import('../supabase/functions/_shared/signup-reservations.ts');
 for(const linked of [false,true]){
 let statusValue='WAITING',reviewId=0,finalized=0,reads=0;
 const service:any={from:(table:string)=>{let operation='select',input:any;const q:any={};for(const method of ['eq','is','in','lte','or','order','limit','select'])q[method]=()=>q;q.update=(v:any)=>{operation='update';input=v;return q;};const result=()=>{
  reads++;if(table==='ot_signup_reservations'){
   if(operation==='update'){statusValue=input.status||statusValue;return {data:{invite_id:inviteId},error:null};}
   return {data:statusValue==='COMPLETE'?[]:[{invite_id:inviteId,claim_id:token,media_path:linked?null:'reviews/private/live.mp3',file_name:'live.mp3',media_source:linked?'LINK':'FILE',media_url:linked?'https://youtu.be/live-test':null}],error:null};
  }
  if(table==='ot_room_invites')return {data:{review_id:reviewId,revoked_at:null,expires_at:'2026-10-09T00:00:00Z'},error:null};
  return {data:null,error:null};};q.maybeSingle=async()=>result();q.then=(a:any,b:any)=>Promise.resolve(result()).then(a,b);return q;},rpc:async(name:string)=>{assert(name===(linked?'vom_ot_finalize_link':'vom_ot_finalize_upload'));reviewId=1;finalized++;return {data:{id:1},error:null};}};
 assert(await processSignupReservations(service,()=>new Date('2026-10-07T09:00:00Z'))===0&&reads===0);
 assert(await processSignupReservations(service,openNow)===1&&statusValue==='COMPLETE'&&finalized===1);
 assert(await processSignupReservations(service,openNow)===0&&finalized===1);
 }
});

Deno.test('live criteria confirmation is required before any signup side effects',async()=>{const {client,state}=fake();await status(await room(publicRequest({live_confirmed:null}),client,openNow),400);assert(state.uploaded.length===0&&state.rpcCalls.length===0);});
Deno.test('HTTPS live links upload only the photo and create a private ordinary review',async()=>{const {client,state}=fake();const response=await room(publicRequest({media_source:'LINK',media_url:'https://youtu.be/live-test',video:null}),client,openNow);await status(response,201);assert(state.uploaded.length===1&&state.uploaded[0].startsWith('profiles/'));assert(state.rpcCalls.some(x=>x.name==='vom_ot_finalize_link'&&x.input.p_media_url==='https://youtu.be/live-test'));assert(!state.rpcCalls.some(x=>x.name==='vom_ot_finalize_upload'));assert(!(await response.text()).includes('youtu.be'));});
Deno.test('live links preserve after-hours reservations and uncertain commit recovery',async()=>{for(const reserveLost of [false,true]){const {client,state}=fake({reserveLost});const response=await room(publicRequest({media_source:'LINK',media_url:'https://drive.google.com/file/d/test/view',video:null}),client,()=>new Date('2026-10-07T10:00:00Z'));await status(response,reserveLost?409:201);assert(state.reserved&&state.uploaded.length===1&&!state.removed.length&&!state.deletedUsers.length);if(!reserveLost)assert((await response.json()).status==='SCHEDULED');}});
Deno.test('unsafe or missing live links never create accounts or upload files',async()=>{for(const link of ['', 'javascript:alert(1)','http://youtu.be/test','https://user:secret@example.com/live','https://localhost/live','https://127.0.0.1/live','https://[::1]/live','https://example.com/'+ 'a'.repeat(2050)]){const {client,state}=fake();await status(await room(publicRequest({media_source:'LINK',media_url:link,video:null}),client,openNow),400);assert(!state.uploaded.length&&!state.rpcCalls.length);}});
Deno.test('only authenticated approved operators can retrieve submitted live links',async()=>{const options={videoSource:'LINK',videoUrl:'https://youtu.be/live-test'};await status(await review(operatorRequest({action:'media_link',review_id:1},false),fake(options).client),401);await status(await review(operatorRequest({action:'media_link',review_id:1}),fake({...options,member:{id:8,role:'모임원',is_active:true}}).client),403);const response=await review(operatorRequest({action:'media_link',review_id:1}),fake({...options,admin:true}).client);await status(response,200);assert((await response.json()).url==='https://youtu.be/live-test'&&response.headers.get('Cache-Control')==='no-store');});
