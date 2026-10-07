import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { ApiError, DEFAULT_ORIGIN, checkRequest, failure, headers, json, tokenHash, validToken } from "../_shared/ot-core.ts";
import { applicantEmail, memberContext, newPassword, signedIn } from "../_shared/member-access.ts";

export async function handle(req: Request, service: any, authClient: any) {
  let origin = DEFAULT_ORIGIN;
  let claim: any = null, createdUser: string | null = null;
  try {
    origin = checkRequest(req);
    if (req.method === "OPTIONS") return new Response(null,{status:204,headers:headers(origin)});
    let body; try {body=await req.json();} catch {throw new ApiError(400,"요청 내용을 확인해 주세요.");}
    if (body.action === "context") {
      const user=await signedIn(req,service);
      return json(origin,{ok:true,...await memberContext(service,user.id)});
    }
    if (body.action === "login") {
      const name=String(body.login_name||"").trim();
      const password=body.password;
      if ((!name && !body.member_id) || name.length>80 || typeof password!=="string" || password.length>64 || !password) throw new ApiError(400,"아이디와 개인 비밀번호를 입력해 주세요.");
      // A selected public display name resolves to the linked Auth identity on the server.
      // No email, password hint or account metadata is exposed in the picker.
      let selected=null;
      if (body.member_id!==undefined && body.member_id!==null && body.member_id!=="") {
        const id=Number(body.member_id);
        if (!Number.isSafeInteger(id)||id<=0) throw new ApiError(400,"회원 이름을 목록에서 선택해 주세요.");
        const {data,error}=await service.from("members").select("id,auth_user_id").eq("id",id).eq("is_active",true).maybeSingle();
        if (error) throw new Error("selected_login_lookup_failed");
        if (!data?.auth_user_id) throw new ApiError(401,"개인 비밀번호를 확인해 주세요. 최초 설정이 필요하다면 운영진에게 개인 설정 링크를 요청해 주세요.");
        selected=data;
      } else {
        const {data,error}=await service.from("members").select("id,auth_user_id").eq("name",name).eq("is_active",true).maybeSingle();
        if (error) throw new Error("legacy_login_lookup_failed");
        if (data?.auth_user_id) selected=data;
      }
      let result;
      if (selected) {
        const {data,error}=await service.auth.admin.getUserById(selected.auth_user_id);
        if (error||!data.user?.email) throw new ApiError(401,"개인 계정 정보를 확인하지 못했습니다. 운영진에게 확인해 주세요.");
        result=await authClient.auth.signInWithPassword({email:data.user.email,password:"VOM:"+password});
        if (result.error) result=await authClient.auth.signInWithPassword({email:data.user.email,password});
        if (!result.error && result.data.session?.user.id!==selected.auth_user_id) throw new ApiError(401,"개인 계정 정보를 다시 확인해 주세요.");
      } else {
        result=await authClient.auth.signInWithPassword({email:await applicantEmail(name.toLowerCase()),password:"VOM:"+password});
      }
      if (result.error || !result.data.session) throw new ApiError(401,"회원 이름 또는 아이디와 개인 비밀번호를 다시 확인해 주세요.");
      const session=result.data.session;
      const context=await memberContext(service,session.user.id);
      if (!['APPROVED','PASSWORD_CHANGE_REQUIRED'].includes(context.state)) {
        await authClient.auth.signOut({scope:'local'});
        throw new ApiError(403,context.state==='PENDING'?'가입 검토 중입니다. 승인 안내를 받은 뒤 로그인해 주세요.':'가입이 완료된 개인 계정으로 로그인해 주세요.','approval_required');
      }
      return json(origin,{ok:true,session:{access_token:session.access_token,refresh_token:session.refresh_token},...context});
    }
    if (body.action === "activation_info" || body.action === "activate") {
      const token=req.headers.get("x-ot-invite");
      if (!validToken(token)) throw new ApiError(404,"개인 설정 링크를 확인해 주세요.");
      const {data:invite,error}=await service.from("member_activation_invites").select("id,member_id,expires_at,consumed_at,revoked_at")
        .eq("token_hash",await tokenHash(token)).maybeSingle();
      if (error) throw new Error("activation_lookup_failed");
      if (!invite || invite.consumed_at || invite.revoked_at || Date.parse(invite.expires_at)<=Date.now()) throw new ApiError(404,"사용됐거나 만료된 개인 설정 링크입니다. 운영진에게 다시 요청해 주세요.");
      const {data:member,error:me}=await service.from("members").select("id,name,auth_user_id").eq("id",invite.member_id).eq("is_active",true).maybeSingle();
      if (me || !member) throw new ApiError(404,"활동 회원 정보를 확인해 주세요.");
      if (body.action === "activation_info") return json(origin,{ok:true,member_name:member.name});
      const password=newPassword(body.password);
      const claimId=crypto.randomUUID(),stamp=new Date().toISOString(),before=new Date(Date.now()-600000).toISOString();
      const {data:reserved,error:re}=await service.from("member_activation_invites").update({claim_id:claimId,claimed_at:stamp})
        .eq("id",invite.id).is("consumed_at",null).is("revoked_at",null).gt("expires_at",stamp)
        .or(`claimed_at.is.null,claimed_at.lt.${before}`).select("id").maybeSingle();
      if (re) throw new Error("activation_reservation_failed");
      if (!reserved) throw new ApiError(409,"개인 설정이 진행 중입니다. 잠시 후 확인해 주세요.");
      claim={id:invite.id,claimId};
      let userId=member.auth_user_id;
      let email="member-"+member.id+"@member.thisisvom.app";
      if (userId) {
        const {data,error}=await service.auth.admin.updateUserById(userId,{password});
        if (error) throw new Error("password_update_failed");
        email=data.user.email;
      } else {
        const {data,error}=await service.auth.admin.createUser({email,password,email_confirm:true});
        if (error || !data.user) throw new ApiError(409,"계정 상태를 운영진에게 확인해 주세요.");
        userId=data.user.id; createdUser=userId;
      }
      const {error:fe}=await service.rpc("vom_activate_member",{p_invite_id:invite.id,p_claim_id:claimId,p_user_id:userId});
      if (fe) throw new Error("activation_commit_failed");
      claim=null; createdUser=null;
      return json(origin,{ok:true,login_email:email,member_name:member.name});
    }
    throw new ApiError(400,"지원하지 않는 요청입니다.");
  } catch(error) {return failure(origin,error);}
  finally {
    if (claim) {
      try {
        const {data:current,error}=await service.from("member_activation_invites").select("consumed_at").eq("id",claim.id).maybeSingle();
        if (!error && current && !current.consumed_at) {
          if (createdUser) await service.auth.admin.deleteUser(createdUser);
          await service.from("member_activation_invites").update({claim_id:null,claimed_at:null}).eq("id",claim.id).eq("claim_id",claim.claimId).is("consumed_at",null);
        }
      } catch {console.error("activation reconciliation deferred");}
    }
  }
}
if (import.meta.main) Deno.serve(req=>handle(req,createClient(Deno.env.get("SUPABASE_URL")||"",Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",{auth:{persistSession:false,autoRefreshToken:false}}),
  createClient(Deno.env.get("SUPABASE_URL")||"",Deno.env.get("SUPABASE_ANON_KEY")||"",{auth:{persistSession:false,autoRefreshToken:false}})));
