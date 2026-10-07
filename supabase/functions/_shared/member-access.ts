import { ApiError, DEFAULT_ORIGIN, newToken, tokenHash } from "./ot-core.ts";

export function loginName(value: unknown) {
  const name = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{3,29}$/.test(name)) throw new ApiError(400, "아이디는 영문 소문자·숫자·._- 조합 4~30자로 입력해 주세요.");
  return name;
}
export function newPassword(value: unknown) {
  if (typeof value !== "string" || value.length < 8 || value.length > 64) throw new ApiError(400, "비밀번호는 8~64자로 입력해 주세요.");
  return "VOM:" + value;
}
export function signupPassword(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}$/.test(value)) throw new ApiError(400, "개인 비밀번호는 숫자 4자리로 입력해 주세요.");
  return "VOM:" + value;
}
export async function applicantEmail(name: string) {
  return "join-" + (await tokenHash(name)).slice(0,48) + "@member.thisisvom.app";
}
export async function signedIn(req: Request, service: any) {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new ApiError(401, "개인 계정으로 로그인해 주세요.", "login_required");
  const { data, error } = await service.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, "로그인 정보를 다시 확인해 주세요.", "login_required");
  return data.user;
}
export async function memberContext(service: any, userId: string) {
  const [{data:admin,error:ae},{data:member,error:me},{data:application,error:pe}] = await Promise.all([
    service.from("admins").select("user_id").eq("user_id",userId).maybeSingle(),
    service.from("members").select("id,name,nickname,is_active,role").eq("auth_user_id",userId).maybeSingle(),
    service.from("ot_room_applicants").select("member_id").eq("auth_user_id",userId).maybeSingle(),
  ]);
  if (ae || me || pe) throw new Error("member_context_failed");
  if (admin) return {state:"APPROVED",is_admin:true,member:member || null};
  if (member?.is_active) {
    const {data:setting,error} = await service.from("member_account_settings").select("must_change_password").eq("member_id",member.id).maybeSingle();
    if (error) throw new Error("account_setting_failed");
    return {state:setting?.must_change_password ? "PASSWORD_CHANGE_REQUIRED" : "APPROVED",is_admin:false,member};
  }
  return {state:application ? "PENDING" : "UNLINKED",is_admin:false,member:null};
}
export async function issueActivation(service: any, memberId: number, actorId: string) {
  const token = newToken();
  const {error:re}=await service.from("member_activation_invites").update({revoked_at:new Date().toISOString()}).eq("member_id",memberId).is("consumed_at",null).is("revoked_at",null);
  if (re) throw new Error("activation_revocation_failed");
  const {error} = await service.from("member_activation_invites").insert({member_id:memberId,token_hash:await tokenHash(token),issued_by:actorId});
  if (error) throw new Error("activation_invite_failed");
  return {url:DEFAULT_ORIGIN+"/activate/#token="+token,message:"본인에게만 전달하는 7일 유효 개인 설정 링크입니다."};
}
