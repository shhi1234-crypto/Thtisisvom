export const VIDEO_BUCKET = "ot-review-videos";
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const REVIEW_MINUTES = 120;
export const APP_ORIGINS = new Set(["https://thisisvom.vercel.app", "https://www.thisisvom.vercel.app"]);
export const DEFAULT_ORIGIN = "https://thisisvom.vercel.app";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = "request_failed") { super(message); }
}

export function isRegistrationOpen(now = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23" }).format(now));
  return hour >= 9 && hour < 18;
}

export function requireOpen(now = new Date()) {
  if (!isRegistrationOpen(now)) throw new ApiError(403, "영상 등록은 한국시간 오전 9시부터 오후 6시 전까지 가능합니다.", "room_closed");
}

export function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function newToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
}

export async function tokenHash(token: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), b => b.toString(16).padStart(2, "0")).join("");
}

export function textField(value: unknown, max: number, label: string) {
  if (typeof value !== "string") throw new ApiError(400, `${label}을 입력해 주세요.`);
  const valueTrimmed = value.trim();
  if (!valueTrimmed || Array.from(valueTrimmed).length > max || /[\x00-\x1f\x7f]/.test(valueTrimmed)) throw new ApiError(400, `${label}을 ${max}자 이내로 입력해 주세요.`);
  return valueTrimmed;
}

export function positiveInt(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ApiError(400, "요청 번호를 확인해 주세요.");
  return parsed;
}

export async function validateVideo(file: File): Promise<{ mime: string; extension: string }> {
  if (!file.size || file.size > MAX_VIDEO_BYTES) throw new ApiError(400, "영상은 0바이트보다 크고 50MB 이하여야 합니다.");
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 16 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "qt  ") return { mime: "video/quicktime", extension: "mov" };
    if (brand.startsWith("3gp")) return { mime: "video/3gpp", extension: "3gp" };
    return { mime: "video/mp4", extension: "mp4" };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { mime: "video/webm", extension: "webm" };
  throw new ApiError(400, "MP4, MOV, WEBM 또는 3GP 영상 파일을 선택해 주세요.");
}

export function headers(origin: string) {
  return {
    "Access-Control-Allow-Origin": APP_ORIGINS.has(origin) ? origin : DEFAULT_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-ot-invite",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin",
  };
}

export function json(origin: string, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: headers(origin) });
}

export function checkRequest(req: Request) {
  const origin = req.headers.get("origin") || DEFAULT_ORIGIN;
  if (req.headers.get("origin") && !APP_ORIGINS.has(origin)) throw new ApiError(403, "허용되지 않은 요청입니다.");
  if (req.method !== "POST" && req.method !== "OPTIONS") throw new ApiError(405, "POST 요청만 가능합니다.");
  return origin;
}

export function failure(origin: string, error: unknown) {
  if (error instanceof ApiError) return json(origin, { error: error.message, code: error.code }, error.status);
  // Do not log candidate names, invite tokens, media URLs, or raw database errors.
  console.error("OT request failed", error instanceof Error ? error.name : "server_error");
  return json(origin, { error: "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.", code: "server_error" }, 500);
}

export async function requireOperator(req: Request, service: any) {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new ApiError(401, "운영진 로그인이 필요합니다.");
  const { data, error } = await service.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, "로그인 정보를 확인하지 못했습니다.");
  const [{ data: admin, error: ae }, { data: member, error: me }, { data: access, error: oe }] = await Promise.all([
    service.from("admins").select("user_id").eq("user_id", data.user.id).maybeSingle(),
    service.from("members").select("id,name,role,is_active").eq("auth_user_id", data.user.id).maybeSingle(),
    service.from("ot_room_operator_access").select("member_id").eq("user_id", data.user.id).is("revoked_at", null).maybeSingle(),
  ]);
  if (ae || me || oe) throw new Error("operator_lookup_failed");
  const isAdmin = !!admin;
  if (!isAdmin && !(member?.role === "운영진" && member.is_active && Number(access?.member_id) === Number(member.id))) throw new ApiError(403, "OT 검토 권한이 필요합니다. 관리자에게 계정 확인을 요청해 주세요.");
  return { userId: data.user.id, isAdmin, memberId: member?.role === "운영진" && member.is_active ? Number(member.id) : null, name: member?.name || "관리자" };
}
